/**
 * Gmail inbound source
 * ====================
 * The Gmail-specific half of inbound processing: claim a SupportInboundJob row
 * (created by the Pub/Sub webhook, keyed on emailAddress + historyId), fetch the
 * messages added since the mailbox's stored cursor, map each Gmail ParsedMessage
 * to the channel-neutral { normalized, signals } shape, and hand the batch to
 * the shared processInboundMessages() pipeline. Then advance the cursor and
 * complete the job.
 *
 * Everything channel-neutral (triage → ingest → draft) lives in
 * src/support/inbound.ts; this file owns only the Gmail delivery model and
 * exposes it through the InboundSource seam (see support/channel-adapter.ts) so
 * the generic sweep/drain in support/queue-worker.ts never imports Gmail.
 */

import { prisma } from '../prisma.js';
import { Prisma } from '../../lib/generated/prisma/client.js';
import { fetchNewMessages, GmailHistoryGoneError, type ParsedMessage } from './fetch.js';
import { extractGmailSignals } from './signals.js';
import { normalizeGmailInbound } from './adapter.js';
import { shouldAdvanceCursor } from './parse.js';
import { processInboundMessages, type InboundItem } from '../support/inbound.js';
import type { InboundSource } from '../support/channel-adapter.js';

const BLOCKED_EMAIL_DOMAINS = (process.env.BLOCKED_EMAIL_DOMAINS || 'hdtl.in, ovrt.in, t.shopifyemail.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/**
 * Claim and process the next SupportInboundJob (or a specific one by id).
 * Returns true if a job was found and handled, false when the queue is empty.
 */
async function processGmailIngestJob(jobId?: string): Promise<boolean> {
  // Guard a targeted claim on non-terminal status so a Pub/Sub redeliver can't
  // re-lock a COMPLETED job; the sweep claim takes PENDING or stale PROCESSING.
  const targetCondition = jobId
    ? Prisma.sql`AND "id" = ${jobId} AND "status" NOT IN ('COMPLETED', 'FAILED') AND "attempts" < "maxAttempts"`
    : Prisma.sql`AND ("status" = 'PENDING' OR ("status" = 'PROCESSING' AND "lockedAt" < NOW() - INTERVAL '5 minutes')) AND "attempts" < "maxAttempts"`;

  // Atomically check out one inbound job row.
  const assignedJobs: Array<{ id: string; emailAddress: string; historyId: string; attempts: number; maxAttempts: number }> =
    await prisma.$queryRaw`
      UPDATE "SupportInboundJob"
      SET "status" = 'PROCESSING', "lockedAt" = NOW(), "attempts" = "attempts" + 1
      WHERE "id" = (
        SELECT "id" FROM "SupportInboundJob"
        WHERE 1=1 ${targetCondition}
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `;

  const job = assignedJobs[0];
  if (!job) return false;

  console.log(`[gmail-inbound] processing job ${job.id} for mailbox ${job.emailAddress} (${jobId ? 'event-driven' : 'sweep'})`);

  try {
    const connection = await prisma.supportChannelConnection.findFirst({
      where: { channelType: 'GMAIL', externalAccountId: job.emailAddress, status: 'ACTIVE' },
    });

    if (!connection || !connection.trackInbound) {
      await prisma.supportInboundJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', lockedAt: null },
      });
      return true;
    }

    const cursor = connection.syncCursor;
    let newMessages: ParsedMessage[] = [];

    try {
      if (cursor) {
        newMessages = await fetchNewMessages(connection.id, cursor);

        // API latency guard: an empty event-driven result can mean the message
        // hasn't propagated to history yet — pause briefly and retry once.
        if (newMessages.length === 0 && jobId) {
          console.log(`[gmail-inbound] empty history window — pausing 1.5s for API propagation...`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          newMessages = await fetchNewMessages(connection.id, cursor);
        }
      }
    } catch (err) {
      if (err instanceof GmailHistoryGoneError) {
        // The stored cursor is older than Gmail retains. Skip the unrecoverable
        // gap by resyncing to this notification's historyId, complete the job,
        // and warn — rather than wedging this job (and all future ones) forever.
        console.warn(
          `[gmail-inbound] stale cursor for ${job.emailAddress} (was ${cursor}); ` +
            `resyncing to historyId ${job.historyId}. Messages in the gap are skipped.`,
        );
        await prisma.supportChannelConnection.update({
          where: { id: connection.id },
          data: { syncCursor: job.historyId, lastHealthCheckAt: new Date() },
        });
        await prisma.supportInboundJob.update({
          where: { id: job.id },
          data: { status: 'COMPLETED', lockedAt: null },
        });
        return true;
      }
      throw err;
    }

    const filteredMessages = newMessages.filter((m) => !isFromBlockedDomain(m.from));

    if (filteredMessages.length < newMessages.length) {
      console.log(
        `[gmail-inbound] filtered ${newMessages.length - filteredMessages.length} message(s) from blocked domain(s)`,
      );
    }

    const items: InboundItem[] = filteredMessages.map((m) => ({
      normalized: normalizeGmailInbound(m),
      signals: extractGmailSignals(m.labelIds, m.headers, m.from),
    }));

    await processInboundMessages(
      { id: connection.id, organisationId: connection.organisationId, channelType: 'GMAIL' },
      items,
    );

    // Advance the cursor checkpoint (only forward — see shouldAdvanceCursor).
    if (shouldAdvanceCursor(connection.syncCursor, job.historyId)) {
      await prisma.supportChannelConnection.update({
        where: { id: connection.id },
        data: { syncCursor: job.historyId, lastHealthCheckAt: new Date() },
      });
    }

    await prisma.supportInboundJob.update({
      where: { id: job.id },
      data: { status: 'COMPLETED', lockedAt: null },
    });
    return true;
  } catch (error: unknown) {
    console.error(`[gmail-inbound] processing exception for job ${job.id}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    const failedPermanently = job.attempts >= job.maxAttempts;
    await prisma.supportInboundJob.update({
      where: { id: job.id },
      data: {
        status: failedPermanently ? 'FAILED' : 'PENDING',
        lockedAt: null,
        error: message,
      },
    });
    // Return true: a job was found and handled (failed), so a drain loop should
    // continue to the next queued job.
    return true;
  }
}

/** Check if an email address is from a blocked domain (universal filter). */
function isFromBlockedDomain(emailAddress: string): boolean {
  if (BLOCKED_EMAIL_DOMAINS.length === 0) return false;
  const domain = emailAddress.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return BLOCKED_EMAIL_DOMAINS.includes(domain);
}

export const gmailInboundSource: InboundSource = {
  channelType: 'GMAIL',
  processIngestJob: processGmailIngestJob,
};

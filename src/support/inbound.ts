/**
 * Shared inbound message pipeline (channel-agnostic)
 * ==================================================
 * The per-message half of inbound processing, extracted from the old
 * Gmail-coupled queue-worker so EVERY channel reuses it. Given a connection and
 * a batch of already-normalized messages (+ their channel signals), it runs the
 * same triage → ingest → inline-draft pipeline regardless of the source channel.
 *
 * The channel-specific half (how a provider's notification turns into these
 * normalized messages — Gmail's historyId batch fetch, a WhatsApp webhook
 * payload, …) lives in each channel's own module behind the InboundSource seam
 * (see channel-adapter.ts). This file knows nothing about Gmail, RFC headers, or
 * historyIds — only NormalizedInboundMessage + ChannelSignals.
 */

import { prisma } from '../prisma.js';
import { triageInbound } from './triage.js';
import { ingestInboundMessage } from './ingest.js';
import { loadAgentConfig } from './config.js';
import { runSupportAgentJob } from './runner.js';
import type { ChannelSignals, NormalizedInboundMessage } from './channel-adapter.js';
import type { SupportChannelType } from '../../lib/generated/prisma/enums.js';

/** The connection a batch of inbound messages belongs to. */
export type InboundConnection = {
  id: string;
  organisationId: string;
  channelType: SupportChannelType;
};

/** One normalized inbound message paired with its channel-derived triage signals. */
export type InboundItem = {
  normalized: NormalizedInboundMessage;
  signals: ChannelSignals;
};

/**
 * Triage, ingest, and (if kept + agent enabled) inline-draft a batch of
 * normalized inbound messages for one connection. Channel-agnostic: the caller
 * (a channel's InboundSource or webhook) supplies the normalized messages and
 * signals; this function never touches provider APIs.
 *
 * Mirrors the old queue-worker inner loop exactly, including its hardening:
 *  - duplicate-key (P2002) on ingest is a concurrent-delivery no-op, swallowed;
 *    any other ingest error re-throws so the caller can retry the batch.
 *  - the agent job is claimed with an atomic QUEUED→RUNNING lock so the fallback
 *    poll worker can't double-run it; an agent failure is contained (re-queued)
 *    and never fails the whole batch.
 */
export async function processInboundMessages(
  connection: InboundConnection,
  items: InboundItem[],
): Promise<void> {
  if (items.length === 0) return;

  const agentConfig = await loadAgentConfig(connection.organisationId);
  const activeRules = agentConfig?.rules ?? [];

  for (const { normalized: m, signals } of items) {
    const decision = await triageInbound(
      { subject: m.topic, body: m.body || m.snippet, from: m.customer.rawHandle, signals },
      activeRules,
    );

    if (!decision.keep) {
      console.log(`[support-inbound] DROP message ${m.externalMessageId} via triage (${decision.via})`);
      continue;
    }

    // Ingest. A duplicate-key violation means a concurrent delivery of the same
    // message won the race — that's the no-op ingest already returns early for,
    // so swallow it; any other error is real and re-thrown for the caller.
    let ingestResult: { conversationId: string } | null = null;
    try {
      ingestResult = await ingestInboundMessage({
        connection: { id: connection.id, organisationId: connection.organisationId, channelType: connection.channelType },
        message: m,
        classification: decision.classification,
        triageIntent: decision.intent,
      });
    } catch (ingestErr: unknown) {
      if (isDuplicateKey(ingestErr)) {
        console.log(`[support-inbound] duplicate ingest skip for message ${m.externalMessageId} (concurrent delivery)`);
      } else {
        console.error(`[support-inbound] ingestion failed for message ${m.externalMessageId}:`, ingestErr);
        throw ingestErr;
      }
    }

    // Inline draft trigger with an atomic lock. Look up the agent job by
    // conversationId (channel-agnostic), not by a platform-specific message id.
    const activeAgentJob = ingestResult
      ? await prisma.supportAgentJob.findFirst({
          where: {
            organisationId: connection.organisationId,
            conversationId: ingestResult.conversationId,
            status: 'QUEUED',
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        })
      : null;

    if (!activeAgentJob) {
      if (ingestResult) {
        console.log(`[support-inbound] no QUEUED agent task for message ${m.externalMessageId} — skipping draft pass`);
      }
      continue;
    }

    // Atomic checkout: lock this job so the fallback poll worker can't also run it.
    const lock = await prisma.supportAgentJob.updateMany({
      where: { id: activeAgentJob.id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    if (lock.count === 0) {
      console.log(`[support-inbound] agent task ${activeAgentJob.id} already claimed by another worker — skipping`);
      continue;
    }

    try {
      await runSupportAgentJob(activeAgentJob.id);
      console.log(`[support-inbound] inline draft complete for message ${m.externalMessageId}`);
    } catch (agentErr) {
      // Contained: a draft failure must not fail the inbound batch (the ingest
      // succeeded). Re-queue so the poll worker retries.
      console.error(`[support-inbound] inline reply generation failed for task ${activeAgentJob.id}:`, agentErr);
      await prisma.supportAgentJob
        .update({ where: { id: activeAgentJob.id }, data: { status: 'QUEUED' } })
        .catch((e) => console.error(`[support-inbound] failed to re-queue agent job ${activeAgentJob.id}:`, e));
    }
  }
}

function isDuplicateKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; message?: string };
  return e.code === 'P2002' || (e.message?.includes('Unique constraint') ?? false);
}

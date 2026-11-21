/**
 * Support sender worker (channel-agnostic outbox)
 * =================================================
 * Polls for SupportMessage rows {direction: OUTBOUND, status: APPROVED} and
 * delivers them via the conversation's channel adapter
 * (getChannelAdapter(channelType).send). This is the "next pass" seam the
 * agent worker left open — the runner wrote APPROVED messages; we send them.
 *
 * Flow per message:
 *   1. Load APPROVED OUTBOUND messages, including conversation + connection.
 *   2. Call adapter.send(...).
 *   3. On success: $transaction(message → SENT + externalMessageId, conversation → ANSWERED).
 *   4. On failure: sendAttempts++; at MAX_SEND_ATTEMPTS, message → FAILED and
 *      conversation → NEEDS_HUMAN; otherwise leave APPROVED for retry.
 *
 * Lifecycle (wired in src/index.ts):
 *   startSupportSenderWorker()    — begin the poll loop
 *   shutdownSupportSenderWorker() — stop polling and drain
 */

import { prisma } from '../prisma.js';
import { getChannelAdapter } from './channel-adapter.js';

const POLL_INTERVAL_MS = 10_000;
const MAX_SEND_ATTEMPTS = 3;

let pollTimer: NodeJS.Timeout | null = null;
// Message ids currently being sent — prevents double-send on overlapping polls.
const inFlight = new Set<string>();

async function sendPendingMessages(): Promise<void> {
  const messages = await prisma.supportMessage.findMany({
    where: { direction: 'OUTBOUND', status: 'APPROVED' },
    include: { conversation: { include: { connection: true } } },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  for (const msg of messages) {
    if (inFlight.has(msg.id)) continue;
    inFlight.add(msg.id);
    sendOne(msg).finally(() => inFlight.delete(msg.id));
  }
}

type PendingMessage = Awaited<ReturnType<typeof prisma.supportMessage.findMany>>[number] & {
  conversation: Awaited<ReturnType<typeof prisma.supportConversation.findFirstOrThrow>> & {
    connection: Awaited<ReturnType<typeof prisma.supportChannelConnection.findFirstOrThrow>>;
  };
};

async function sendOne(msg: PendingMessage): Promise<void> {
  const { conversation } = msg;
  const adapter = getChannelAdapter(conversation.channelType);

  // Guard against the send-succeeds-but-DB-transaction-fails race: if a prior
  // attempt already sent this message and stored an externalMessageId, treat it
  // as already sent rather than resending and creating a duplicate customer email.
  if (msg.externalMessageId) {
    await prisma.$transaction([
      prisma.supportMessage.update({
        where: { id: msg.id },
        data: { status: 'SENT', sentAt: new Date() },
      }),
      prisma.supportConversation.update({
        where: { id: conversation.id },
        data: { status: 'ANSWERED', lastOutboundAt: new Date() },
      }),
    ]);
    console.log(`[support-sender] conversation ${conversation.id}: already sent (${msg.externalMessageId}) — marking SENT without resend`);
    return;
  }

  try {
    const result = await adapter.send({
      organisationId: conversation.organisationId,
      connectionId: conversation.channelConnectionId,
      externalConversationId: conversation.externalConversationId,
      toHandle: msg.toHandle,
      fromHandle: msg.fromHandle,
      topic: msg.subject,
      body: msg.body,
      replyMeta: msg.channelMeta as Record<string, unknown>,
    });

    // Write externalMessageId first, in its own update, so that if the status
    // transaction below fails the retry guard above detects the sent message
    // and marks it SENT without calling adapter.send() again (no duplicate email).
    await prisma.supportMessage.update({
      where: { id: msg.id },
      data: { externalMessageId: result.externalMessageId },
    });

    await prisma.$transaction([
      prisma.supportMessage.update({
        where: { id: msg.id },
        data: { status: 'SENT', sentAt: new Date() },
      }),
      prisma.supportConversation.update({
        where: { id: conversation.id },
        data: { status: 'ANSWERED', lastOutboundAt: new Date() },
      }),
    ]);

    console.log(`[support-sender] conversation ${conversation.id}: sent → ${result.externalMessageId}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[support-sender] conversation ${conversation.id}: send failed — ${errorMsg}`);

    const sendAttempts = msg.sendAttempts + 1;

    if (sendAttempts >= MAX_SEND_ATTEMPTS) {
      // Too many failures — escalate so a human can intervene.
      await prisma.$transaction([
        prisma.supportMessage.update({
          where: { id: msg.id },
          data: { status: 'FAILED', sendAttempts },
        }),
        prisma.supportConversation.update({
          where: { id: conversation.id },
          data: { status: 'NEEDS_HUMAN' },
        }),
      ]);
      console.error(
        `[support-sender] conversation ${conversation.id}: max send attempts reached — escalated to NEEDS_HUMAN`,
      );
    } else {
      // Record the attempt but leave APPROVED for retry.
      await prisma.supportMessage.update({
        where: { id: msg.id },
        data: { sendAttempts },
      });
    }
  }
}

export function startSupportSenderWorker(): void {
  pollTimer = setInterval(() => {
    sendPendingMessages().catch((err) => console.error('[support-sender] poll error:', err));
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
  console.log(`[support-sender] worker started (poll=${POLL_INTERVAL_MS}ms)`);
}

export async function shutdownSupportSenderWorker(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // Wait for any in-flight sends to finish (they're plain promises, not a pool).
  // Give them up to 15s then continue — the next startup will retry.
  if (inFlight.size > 0) {
    console.log(`[support-sender] draining ${inFlight.size} in-flight send(s)...`);
    await new Promise<void>((resolve) => setTimeout(resolve, 15_000));
  }
  console.log('[support-sender] worker shut down');
}

/**
 * Support message ingestion → conversation + message + agent enqueue
 * =====================================================================
 * Called by each channel's webhook for every genuinely-new inbound message
 * the triage cascade decided to KEEP. Persists the conversation as a
 * SupportConversation (one per [channelConnectionId, externalConversationId])
 * owning SupportMessage rows, then — if the org's agent is enabled — enqueues
 * a SupportAgentJob to draft a reply.
 *
 * Idempotent on [conversationId, externalMessageId] so a redelivered webhook
 * can't create a duplicate message or a duplicate agent job.
 */

import { prisma } from '../prisma.js';
import type { Classification } from './classifier.js';
import type { NormalizedInboundMessage } from './channel-adapter.js';
import { classifyIntent, heuristicIntent } from './intent.js';
import type { SupportChannelType, SupportIntent } from '../../lib/generated/prisma/enums.js';

type IngestArgs = {
  connection: { id: string; organisationId: string; channelType: SupportChannelType };
  message: NormalizedInboundMessage;
  classification: Classification;
  /** Intent decided during triage's LLM gate, if it ran. */
  triageIntent?: SupportIntent;
};

export async function ingestInboundMessage(args: IngestArgs): Promise<{ conversationId: string } | null> {
  const { connection, message: m, classification, triageIntent } = args;
  const sentAt = m.sentAt ?? new Date();

  // Idempotency: a redelivered webhook for the same external message id is a no-op.
  const existing = await prisma.supportMessage.findFirst({
    where: { organisationId: connection.organisationId, externalMessageId: m.externalMessageId },
    select: { id: true },
  });
  if (existing) {
    console.log(`[support-ingest] message ${m.externalMessageId} already ingested — skipping`);
    return null;
  }

  const existingConversation = await prisma.supportConversation.findUnique({
    where: {
      channelConnectionId_externalConversationId: {
        channelConnectionId: connection.id,
        externalConversationId: m.externalConversationId,
      },
    },
    select: { id: true, intent: true },
  });

  // Resolve intent for a brand-new conversation: prefer triage's gate result,
  // else run the gate now, else fall back to the no-LLM heuristic.
  let intent: SupportIntent;
  if (existingConversation) {
    intent = existingConversation.intent;
  } else if (triageIntent) {
    intent = triageIntent;
  } else {
    const gated = await classifyIntent({ topic: m.topic, body: m.body, fromHandle: m.customer.rawHandle });
    intent = gated?.intent ?? heuristicIntent({ topic: m.topic, body: m.body, fromHandle: m.customer.rawHandle });
  }

  // 1. Upsert the conversation, keyed on [channelConnectionId, externalConversationId].
  //    The `update` block intentionally does NOT reset status — we do that in a
  //    second targeted update below so we only re-open from terminal statuses.
  const conversation = await prisma.supportConversation.upsert({
    where: {
      channelConnectionId_externalConversationId: {
        channelConnectionId: connection.id,
        externalConversationId: m.externalConversationId,
      },
    },
    create: {
      organisationId: connection.organisationId,
      channelType: connection.channelType,
      channelConnectionId: connection.id,
      externalConversationId: m.externalConversationId,
      subject: m.topic,
      customerName: m.customer.displayName,
      customerHandle: m.customer.handle,
      customerRawHandle: m.customer.rawHandle,
      status: 'OPEN',
      intent,
      lowConfidence: classification.lowConfidence,
      lastInboundAt: sentAt,
    },
    update: {
      subject: m.topic,
      lowConfidence: classification.lowConfidence,
      lastInboundAt: sentAt,
    },
  });

  // Re-open only from terminal statuses. AWAITING_APPROVAL / READY_TO_SEND
  // already have an in-progress draft — resetting them to OPEN would orphan it.
  await prisma.supportConversation.updateMany({
    where: { id: conversation.id, status: { in: ['ANSWERED', 'NEEDS_HUMAN'] } },
    data: { status: 'OPEN' },
  });

  // 2. Record the inbound message. A unique violation here means a concurrent
  //    delivery of the same message won the race between our idempotency check
  //    above and this insert (e.g. Pub/Sub redelivering before the cursor/row
  //    commits) — that's the no-op this function already returns early for, so
  //    swallow it rather than surfacing a 500 and triggering a retry loop.
  try {
    await prisma.supportMessage.create({
      data: {
        conversationId: conversation.id,
        organisationId: connection.organisationId,
        direction: 'INBOUND',
        status: 'RECEIVED',
        externalMessageId: m.externalMessageId,
        fromHandle: m.customer.rawHandle,
        toHandle: m.toHandle,
        subject: m.topic,
        snippet: m.snippet,
        body: m.body,
        sentAt,
        channelMeta: m.channelMeta as object,
        classScore: classification.confidence,
        classReasons: classification.reasons,
        lowConfidence: classification.lowConfidence,
        intent,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.log(
        `[support-ingest] message ${m.externalMessageId} already ingested (concurrent delivery) — skipping`,
      );
      return null;
    }
    throw err;
  }

  // 3. Enqueue an agent job — only if the org has an enabled agent. The partial
  //    unique index on (conversationId) for active jobs means a burst of
  //    messages on one conversation won't double-enqueue; we swallow that
  //    unique-violation.
  const config = await prisma.supportAgentConfig.findUnique({
    where: { organisationId: connection.organisationId },
    select: { mode: true },
  });

  if (!config || config.mode === 'OFF') {
    console.log(
      `[support-ingest] conversation ${conversation.id} stored; agent ${config ? 'OFF' : 'unconfigured'} — no job`,
    );
    return { conversationId: conversation.id };
  }

  try {
    await prisma.supportAgentJob.create({
      data: {
        organisationId: connection.organisationId,
        conversationId: conversation.id,
        triggeringMessageId: m.externalMessageId,
        status: 'QUEUED',
      },
    });
    console.log(
      `[support-ingest] conversation ${conversation.id} stored; agent job queued (mode=${config.mode})`,
    );
  } catch (err) {
    // Unique violation = a job for this conversation is already QUEUED/RUNNING.
    // That's fine — the existing job will pick up this newest message when it runs.
    if (isUniqueViolation(err)) {
      console.log(
        `[support-ingest] conversation ${conversation.id}: active agent job already exists — not re-queued`,
      );
    } else {
      throw err;
    }
  }

  return { conversationId: conversation.id };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

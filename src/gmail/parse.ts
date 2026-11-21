/**
 * Pure decode/compare helpers for the Gmail push webhook.
 * ======================================================
 * Kept dependency-free (no Prisma) so they're unit-testable in isolation and so
 * the handler in webhook.ts stays thin.
 */

export type PubSubEnvelope = {
  message?: {
    data?: string; // base64 Gmail payload
    messageId?: string;
    message_id?: string; // older field name
    publishTime?: string;
    publish_time?: string;
  };
  subscription?: string;
};

type GmailPayload = {
  emailAddress?: string;
  historyId?: string | number;
};

export type ParsedPush = {
  messageId: string;
  emailAddress: string;
  historyId: string;
  publishedAt: Date | null;
};

/**
 * Pure decode of a Pub/Sub push envelope into the fields we persist. Returns
 * null for anything we'd ACK-and-drop (malformed/missing), so the handler never
 * has to repeat these checks.
 */
export function parsePushEnvelope(envelope: PubSubEnvelope): ParsedPush | null {
  const msg = envelope.message;
  const messageId = msg?.messageId ?? msg?.message_id;
  if (!msg?.data || !messageId) return null;

  let payload: GmailPayload;
  try {
    payload = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8'));
  } catch {
    return null;
  }

  const emailAddress = payload.emailAddress;
  const historyId = payload.historyId != null ? String(payload.historyId) : undefined;
  if (!emailAddress || !historyId) return null;

  const publishTimeRaw = msg.publishTime ?? msg.publish_time;
  return {
    messageId,
    emailAddress,
    historyId,
    publishedAt: publishTimeRaw ? new Date(publishTimeRaw) : null,
  };
}

/**
 * True if `incoming` historyId should advance the stored cursor. historyIds are
 * monotonic per mailbox, so only move forward — out-of-order / coalesced pushes
 * must not rewind it. BigInt because historyIds can exceed Number.MAX_SAFE_INTEGER.
 */
export function shouldAdvanceCursor(stored: string | null, incoming: string): boolean {
  if (!stored) return true;
  return BigInt(incoming) > BigInt(stored);
}

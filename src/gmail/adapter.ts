/**
 * Gmail channel adapter
 * =====================
 * Implements ChannelAdapter for channelType=GMAIL and normalizes a fetched
 * Gmail message into the channel-agnostic NormalizedInboundMessage shape.
 * Registered once at startup via registerChannelAdapter(gmailAdapter).
 *
 * Threading: Gmail's `channelMeta` carries RFC 2822 headers
 * ({ messageIdHeader, inReplyToHeader, references }). buildReplyMeta() turns
 * an inbound message's headers into the headers for our reply (In-Reply-To =
 * inbound's Message-ID; References = inbound's References chain + its
 * Message-ID).
 */

import type { ChannelAdapter, NormalizedInboundMessage, OutboundSendRequest } from '../support/channel-adapter.js';
import type { ParsedMessage } from './fetch.js';
import { parseEmailAddress } from '../support/email-address.js';
import { sendGmailReply } from './send.js';

const GMAIL_HEADERS_SCHEMA_KEYS = ['messageIdHeader', 'inReplyToHeader', 'references'] as const;

type GmailChannelMeta = {
  messageIdHeader: string | null;
  inReplyToHeader: string | null;
  references: string | null;
};

/** Defensively read Gmail header fields out of a channelMeta blob (malformed → all null). */
function readGmailChannelMeta(meta: Record<string, unknown>): GmailChannelMeta {
  const out: Partial<GmailChannelMeta> = {};
  for (const key of GMAIL_HEADERS_SCHEMA_KEYS) {
    const v = meta[key];
    out[key] = typeof v === 'string' ? v : null;
  }
  return out as GmailChannelMeta;
}

/** Normalize a fetched Gmail message into the shared inbound shape. */
export function normalizeGmailInbound(m: ParsedMessage): NormalizedInboundMessage {
  const from = parseEmailAddress(m.from);
  const channelMeta: GmailChannelMeta = {
    messageIdHeader: m.headers['message-id'] ?? null,
    inReplyToHeader: m.headers['in-reply-to'] ?? null,
    references: m.headers['references'] ?? null,
  };

  return {
    externalConversationId: m.threadId,
    externalMessageId: m.id,
    topic: m.subject,
    customer: {
      displayName: from.name,
      handle: from.email ?? m.from.trim().toLowerCase(),
      rawHandle: m.from,
    },
    toHandle: m.to,
    body: m.body,
    snippet: m.snippet,
    sentAt: m.date ? new Date(m.date) : null,
    channelMeta,
  };
}

/** Append the inbound Message-ID to its References chain (RFC 2822 threading). */
function buildReferences(existing: string | null, messageId: string | null): string | null {
  const parts = [existing, messageId].filter((s): s is string => !!s && s.trim().length > 0);
  return parts.length ? parts.join(' ') : null;
}

export const gmailAdapter: ChannelAdapter = {
  channelType: 'GMAIL',

  styleHint: [
    'CHANNEL: email.',
    'You are replying to an email. Open with a brief greeting and close politely. Plain text only.',
  ].join(' '),

  usesSignature: true,

  buildReplyMeta(inbound) {
    const inMeta = readGmailChannelMeta(inbound.channelMeta);
    const reply: GmailChannelMeta = {
      messageIdHeader: null,
      inReplyToHeader: inMeta.messageIdHeader,
      references: buildReferences(inMeta.references, inMeta.messageIdHeader),
    };
    return reply;
  },

  replyTopic(topic: string): string {
    return /^re:/i.test(topic.trim()) ? topic : `Re: ${topic}`;
  },

  async send(req: OutboundSendRequest): Promise<{ externalMessageId: string }> {
    const meta = readGmailChannelMeta(req.replyMeta);
    const result = await sendGmailReply({
      connectionId: req.connectionId,
      externalConversationId: req.externalConversationId,
      from: req.fromHandle,
      to: req.toHandle,
      subject: req.topic,
      body: req.body,
      inReplyToHeader: meta.inReplyToHeader,
      references: meta.references,
    });
    return { externalMessageId: result.gmailMessageId };
  },
};

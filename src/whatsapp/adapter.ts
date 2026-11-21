/**
 * WhatsApp channel adapter
 * ========================
 * Implements ChannelAdapter for channelType=WHATSAPP and normalizes a parsed
 * webhook message into the channel-agnostic NormalizedInboundMessage shape.
 * Registered once at startup via registerChannelAdapter(whatsappAdapter).
 *
 * No threading metadata: WhatsApp has no message-id reply chain to track for
 * context, so buildReplyMeta() is a no-op and channelMeta stays empty.
 */

import type { ChannelAdapter, NormalizedInboundMessage, OutboundSendRequest } from '../support/channel-adapter.js';
import type { ParsedWhatsAppMessage } from './parse.js';
import { resolveWhatsAppConnection } from './credentials.js';
import { sendText } from './client.js';

/** Normalize a parsed WhatsApp webhook message into the shared inbound shape. */
export function normalizeWhatsAppInbound(m: ParsedWhatsAppMessage): NormalizedInboundMessage {
  return {
    externalConversationId: m.externalConversationId,
    externalMessageId: m.externalMessageId,
    topic: '',
    customer: {
      displayName: m.displayName,
      handle: m.fromHandle,
      rawHandle: m.fromHandle,
    },
    toHandle: m.toHandle,
    body: m.body,
    snippet: m.snippet,
    sentAt: m.sentAt,
    channelMeta: {},
  };
}

export const whatsappAdapter: ChannelAdapter = {
  channelType: 'WHATSAPP',

  styleHint: [
    'CHANNEL: WhatsApp.',
    'You are replying in a WhatsApp chat. Keep it short and casual — no greeting, no signoff. Plain text only.',
  ].join(' '),

  usesSignature: false,

  buildReplyMeta() {
    return {};
  },

  replyTopic(topic: string): string {
    return topic;
  },

  async send(req: OutboundSendRequest): Promise<{ externalMessageId: string }> {
    const connection = await resolveWhatsAppConnection(req.connectionId);
    const result = await sendText(connection.phoneNumberId, connection.accessToken, req.toHandle, req.body);
    return { externalMessageId: result.messageId };
  },
};

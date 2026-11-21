/**
 * Pure parsing of a WhatsApp Cloud API webhook POST body.
 * =========================================================
 * Kept dependency-free (no Prisma) so it's unit-testable in isolation, same
 * rationale as src/gmail/parse.ts. Each `entry[].changes[].value` can carry a
 * `messages[]` array (new inbound messages) and/or a `statuses[]` array
 * (delivery/read receipts) — only the former matters here.
 */

export type WhatsAppWebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: WhatsAppChangeValue;
    }>;
  }>;
};

type WhatsAppChangeValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: WhatsAppMessage[];
  statuses?: unknown[];
};

type WhatsAppMessage = {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  audio?: Record<string, unknown>;
};

export type ParsedWhatsAppMessage = {
  phoneNumberId: string;
  externalMessageId: string;
  externalConversationId: string;
  fromHandle: string;
  displayName: string | null;
  toHandle: string;
  body: string;
  snippet: string;
  sentAt: Date | null;
};

const MEDIA_LABELS: Record<string, string> = {
  image: 'Image',
  video: 'Video',
  document: 'Document',
  audio: 'Audio',
};

function bodyForMessage(m: WhatsAppMessage): string | null {
  if (m.type === 'text') return m.text?.body ?? null;

  const label = m.type ? MEDIA_LABELS[m.type] : undefined;
  if (!label) return null;

  const caption =
    m.type === 'image' ? m.image?.caption
    : m.type === 'video' ? m.video?.caption
    : m.type === 'document' ? m.document?.caption
    : undefined;

  return caption ? `[${label}] ${caption}` : `[${label}]`;
}

/**
 * Parse one webhook POST body into zero or more normalized messages. Meta can
 * batch multiple entries/changes/messages in a single delivery. Returns []
 * for statuses-only payloads or anything unparseable — the webhook drops
 * those silently (still 200s, since they're not malicious, just not new mail).
 */
export function parseWhatsAppWebhook(body: WhatsAppWebhookBody): ParsedWhatsAppMessage[] {
  const out: ParsedWhatsAppMessage[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      const toHandle = value.metadata?.display_phone_number;
      if (!phoneNumberId) continue;

      const contactsByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]));

      for (const m of value.messages) {
        const externalMessageId = m.id;
        const fromHandle = m.from;
        if (!externalMessageId || !fromHandle) continue;

        const text = bodyForMessage(m);
        if (text === null) continue;

        const sentAt = m.timestamp ? new Date(Number(m.timestamp) * 1000) : null;

        out.push({
          phoneNumberId,
          externalMessageId,
          externalConversationId: fromHandle,
          fromHandle,
          displayName: contactsByWaId.get(fromHandle) ?? null,
          toHandle: toHandle ?? phoneNumberId,
          body: text,
          snippet: text.slice(0, 200),
          sentAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt : null,
        });
      }
    }
  }

  return out;
}

/**
 * WhatsApp Cloud API client
 * =========================
 * Thin fetch wrapper around the Graph API messages endpoint. Token exchange,
 * app-subscription, and phone-number lookups happen in the frontend's
 * Embedded Signup callback (causal-frontend/lib/datasources/whatsapp.ts) —
 * the backend only ever sends messages through an already-connected number.
 */

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export type SendTextResult = { messageId: string };

/** Send a plain-text WhatsApp message via the Cloud API. */
export async function sendText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
): Promise<SendTextResult> {
  const res = await fetch(`${GRAPH_API_BASE}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    messages?: Array<{ id: string }>;
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(json.error?.message ?? `WhatsApp send failed (${res.status})`);
  }

  const messageId = json.messages?.[0]?.id;
  if (!messageId) throw new Error('WhatsApp send response missing message id');
  return { messageId };
}

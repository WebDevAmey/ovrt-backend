import type { Context } from 'hono';
import { prisma } from '../prisma.js';
import { verifyWebhookHandshake, verifyWebhookSignature } from './webhook-verify.js';
import { parseWhatsAppWebhook, type WhatsAppWebhookBody } from './parse.js';
import { normalizeWhatsAppInbound } from './adapter.js';
import { extractWhatsAppSignals } from './signals.js';
import { processInboundMessages, type InboundItem } from '../support/inbound.js';

/** GET /whatsapp/webhook — the one-time Meta handshake when saving the webhook URL. */
export async function handleWhatsAppVerify(c: Context): Promise<Response> {
  const result = verifyWebhookHandshake(
    c.req.query('hub.mode'),
    c.req.query('hub.verify_token'),
    c.req.query('hub.challenge'),
  );
  if (!result.ok) return c.text('Forbidden', 403);
  return c.text(result.challenge, 200);
}

/** POST /whatsapp/webhook — Meta's message delivery push. Always 200s quickly. */
export async function handleWhatsAppEvent(c: Context): Promise<Response> {
  const rawBody = await c.req.text();

  if (!verifyWebhookSignature(rawBody, c.req.header('x-hub-signature-256'))) {
    console.warn('[whatsapp-webhook] signature verification failed — dropping');
    return c.text('Unauthorized', 401);
  }

  let body: WhatsAppWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn('[whatsapp-webhook] unparseable JSON body — dropping');
    return c.body(null, 200);
  }

  const parsed = parseWhatsAppWebhook(body);
  if (parsed.length === 0) return c.body(null, 200);

  // Quick 200 first — Meta retries aggressively and times out fast. Processing
  // happens in the background, same pattern as Gmail's push webhook.
  setImmediate(() => {
    processWhatsAppMessages(parsed).catch((err) => {
      console.error('[whatsapp-webhook-async] background processing crashed:', err);
    });
  });

  return c.body(null, 200);
}

async function processWhatsAppMessages(messages: Awaited<ReturnType<typeof parseWhatsAppWebhook>>): Promise<void> {
  const byPhoneNumberId = new Map<string, typeof messages>();
  for (const m of messages) {
    const bucket = byPhoneNumberId.get(m.phoneNumberId);
    if (bucket) bucket.push(m);
    else byPhoneNumberId.set(m.phoneNumberId, [m]);
  }

  for (const [phoneNumberId, batch] of byPhoneNumberId) {
    const connection = await prisma.supportChannelConnection.findFirst({
      where: { channelType: 'WHATSAPP', externalAccountId: phoneNumberId, status: 'ACTIVE' },
      select: { id: true, organisationId: true, trackInbound: true },
    });

    if (!connection) {
      console.warn(`[whatsapp-webhook] no active connection for phone_number_id ${phoneNumberId} — dropping`);
      continue;
    }
    if (!connection.trackInbound) {
      console.log(`[whatsapp-webhook] ${phoneNumberId} has trackInbound=false — discarding`);
      continue;
    }

    const items: InboundItem[] = batch.map((m) => ({
      normalized: normalizeWhatsAppInbound(m),
      signals: extractWhatsAppSignals(),
    }));

    await processInboundMessages(
      { id: connection.id, organisationId: connection.organisationId, channelType: 'WHATSAPP' },
      items,
    );
  }
}

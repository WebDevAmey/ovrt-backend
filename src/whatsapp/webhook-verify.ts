/**
 * WhatsApp Cloud API webhook verification
 * ========================================
 * Two distinct checks: the one-time GET handshake Meta uses to validate the
 * webhook URL when saved in the App Dashboard, and the HMAC-SHA256 signature
 * Meta attaches to every POST delivery. Simpler than Gmail's pubsub-auth.ts
 * (no JWKS fetch) since Meta signs with our own shared app secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type HandshakeResult = { ok: true; challenge: string } | { ok: false };

/** Verify the GET handshake query params Meta sends to confirm webhook ownership. */
export function verifyWebhookHandshake(
  mode: string | undefined,
  token: string | undefined,
  challenge: string | undefined,
): HandshakeResult {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected) return { ok: false };
  if (mode !== 'subscribe' || token !== expected || !challenge) return { ok: false };
  return { ok: true, challenge };
}

/** Verify the X-Hub-Signature-256 header (HMAC-SHA256 over the raw body) using WHATSAPP_APP_SECRET. */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !signatureHeader) return false;

  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');

  const providedBuf = Buffer.from(provided, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

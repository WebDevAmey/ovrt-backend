import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPersona, type Persona } from './personas.js';

export type ServicePurpose = 'chat' | 'analyst' | 'gmail' | 'support' | 'content' | 'revenue-loss' | 'shopify-data';

export type ServicePayload = {
  userId: string;
  orgId: string;
  purpose: ServicePurpose;
  conversationId?: string;
  model?: Persona;
};

type SignedTokenPayload = ServicePayload & { exp: number };

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

function getSecret(): string | null {
  const s = process.env.LLM_PROXY_SECRET;
  if (typeof s !== 'string' || s.length === 0) return null;
  return s;
}

export function signServiceToken(payload: ServicePayload, ttlSeconds: number = 60): string {
  const secret = getSecret();
  if (!secret) throw new Error('LLM_PROXY_SECRET is not set');
  const full: SignedTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const json = JSON.stringify(full);
  const encodedPayload = b64urlEncode(Buffer.from(json, 'utf8'));
  const sig = createHmac('sha256', secret).update(encodedPayload).digest();
  return `${encodedPayload}.${b64urlEncode(sig)}`;
}

// --- Analytics service tokens -------------------------------------------------
// The ovrt-analytics server authenticates the *calling service* (not a user)
// with the same shared LLM_PROXY_SECRET HMAC scheme. Its verifier expects a
// payload of { service, purpose: 'analytics', storeId? }, distinct from the
// user-scoped tokens above. This helper mints that shape so this backend can
// call the analytics server's protected endpoints; send the result in the
// `x-service-token` header.

export type AnalyticsServiceName = 'causal-backend' | 'causal-frontend' | 'ovrt-analytics';

export function signAnalyticsToken(
  service: AnalyticsServiceName,
  opts: { storeId?: string; ttlSeconds?: number } = {},
): string {
  const secret = getSecret();
  if (!secret) throw new Error('LLM_PROXY_SECRET is not set');
  const full = {
    service,
    purpose: 'analytics' as const,
    ...(opts.storeId ? { storeId: opts.storeId } : {}),
    exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 60),
  };
  const encodedPayload = b64urlEncode(Buffer.from(JSON.stringify(full), 'utf8'));
  const sig = createHmac('sha256', secret).update(encodedPayload).digest();
  return `${encodedPayload}.${b64urlEncode(sig)}`;
}

export function verifyServiceToken(token: string): ServicePayload | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  const secret = getSecret();
  if (!secret) return null;

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigPart);
  } catch {
    return null;
  }
  const expectedSig = createHmac('sha256', secret).update(payloadPart).digest();
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(providedSig, expectedSig)) return null;

  let parsed: unknown;
  try {
    const decoded = b64urlDecode(payloadPart).toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.userId !== 'string' ||
    typeof p.orgId !== 'string' ||
    typeof p.purpose !== 'string' ||
    (p.purpose !== 'chat' &&
      p.purpose !== 'analyst' &&
      p.purpose !== 'gmail' &&
      p.purpose !== 'support' &&
      p.purpose !== 'content' &&
      p.purpose !== 'revenue-loss' &&
      p.purpose !== 'shopify-data') ||
    typeof p.exp !== 'number' ||
    !Number.isFinite(p.exp)
  ) {
    return null;
  }
  if (p.purpose === 'chat' && typeof p.conversationId !== 'string') return null;
  // model is optional; if present it must be one of the known personas
  if (p.model !== undefined && !isPersona(p.model)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (p.exp <= now) return null;

  const out: ServicePayload = {
    userId: p.userId,
    orgId: p.orgId,
    purpose: p.purpose,
  };
  if (typeof p.conversationId === 'string') out.conversationId = p.conversationId;
  if (isPersona(p.model)) out.model = p.model;
  return out;
}

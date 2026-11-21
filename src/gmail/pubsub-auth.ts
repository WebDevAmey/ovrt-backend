/**
 * Pub/Sub push OIDC verification
 * ==============================
 * A push subscription configured with an OIDC token attaches a Google-signed
 * JWT as `Authorization: Bearer <jwt>`. Verifying it proves the request really
 * came from our subscription (Google's signing key) and targets us (audience),
 * so a forged POST to the public webhook is rejected.
 *
 * We verify with Node's built-in crypto against Google's published JWKS — no
 * jose/google-auth-library dependency. Keys are cached per `kid` until the
 * Cache-Control max-age on the JWKS response elapses.
 *
 * Required env vars:
 *   GMAIL_PUSH_AUDIENCE        — the `aud` we require (the OIDC token audience
 *                                you set on the subscription; typically the
 *                                webhook URL).
 *   GMAIL_PUSH_SERVICE_ACCOUNT — the service-account email we require in `email`
 *                                (the SA the subscription uses to mint tokens).
 */

import { createPublicKey, createVerify } from 'node:crypto';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

type Jwk = {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg?: string;
};

let jwksCache: { keys: Map<string, Jwk>; expiresAt: number } | null = null;

async function getJwks(): Promise<Map<string, Jwk>> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;

  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error(`failed to fetch Google JWKS: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };

  const keys = new Map<string, Jwk>();
  for (const k of body.keys) keys.set(k.kid, k);

  // Respect Cache-Control max-age; default to 1h if absent.
  const cc = res.headers.get('cache-control') ?? '';
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 3600);
  jwksCache = { keys, expiresAt: Date.now() + maxAge * 1000 };
  return keys;
}

type DecodedToken = {
  header: { alg: string; kid: string };
  payload: { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean };
  signingInput: string;
  signature: Buffer;
};

function decode(jwt: string): DecodedToken | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return {
      header,
      payload,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url'),
    };
  } catch {
    return null;
  }
}

export type PushAuthResult =
  | { ok: true; serviceAccount: string }
  | { ok: false; reason: string };

/**
 * Verify the Bearer JWT from a Pub/Sub push. Pass the raw Authorization header
 * value (or just the token). Returns ok:false with a reason rather than
 * throwing, so the webhook can decide the status code.
 */
export async function verifyPushToken(authHeader: string | undefined): Promise<PushAuthResult> {
  if (!authHeader) return { ok: false, reason: 'missing Authorization header' };
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  const decoded = decode(jwt);
  if (!decoded) return { ok: false, reason: 'malformed token' };
  if (decoded.header.alg !== 'RS256') return { ok: false, reason: `unexpected alg ${decoded.header.alg}` };

  const { iss, aud, exp, email, email_verified } = decoded.payload;

  if (!iss || !GOOGLE_ISSUERS.has(iss)) return { ok: false, reason: `bad issuer ${iss}` };
  if (!exp || exp * 1000 < Date.now()) return { ok: false, reason: 'token expired' };

  const expectedAud = process.env.GMAIL_PUSH_AUDIENCE;
  if (expectedAud && aud !== expectedAud) return { ok: false, reason: 'audience mismatch' };

  const expectedSa = process.env.GMAIL_PUSH_SERVICE_ACCOUNT;
  if (expectedSa) {
    if (email !== expectedSa) return { ok: false, reason: 'service-account mismatch' };
    if (email_verified === false) return { ok: false, reason: 'email not verified' };
  }

  // Signature check against the matching JWKS key.
  const jwks = await getJwks();
  const jwk = jwks.get(decoded.header.kid);
  if (!jwk) return { ok: false, reason: `unknown signing key ${decoded.header.kid}` };

  const pubKey = createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(decoded.signingInput);
  const valid = verifier.verify(pubKey, decoded.signature);
  if (!valid) return { ok: false, reason: 'signature verification failed' };

  return { ok: true, serviceAccount: email ?? 'unknown' };
}

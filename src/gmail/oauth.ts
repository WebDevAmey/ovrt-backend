/**
 * Google OAuth token exchange
 * ===========================
 * Gmail access tokens are short-lived (~1h). We never persist a usable access
 * token long-term; instead we hold the long-lived refresh token (encrypted in
 * GmailAccount.refreshTokenRef) and mint a fresh access token on demand here.
 *
 * Done with plain fetch against Google's token endpoint so we don't pull in the
 * full googleapis SDK just to refresh a token + call two REST endpoints.
 *
 * Required env vars:
 *   GOOGLE_OAUTH_CLIENT_ID
 *   GOOGLE_OAUTH_CLIENT_SECRET
 * These are the same OAuth client the frontend used to obtain the refresh token
 * during account connection.
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type AccessToken = {
  token: string;
  /** Absolute expiry, computed from the response's expires_in. */
  expiresAt: Date;
};

function getOAuthClient(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET must be set to refresh Gmail tokens',
    );
  }
  return { clientId, clientSecret };
}

/**
 * Exchange a refresh token for a fresh access token. Throws with Google's error
 * body on failure so the caller can surface "invalid_grant" (revoked consent),
 * which is the signal to mark the GmailAccount unhealthy.
 */
export async function refreshAccessToken(refreshToken: string): Promise<AccessToken> {
  const { clientId, clientSecret } = getOAuthClient();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !json.access_token) {
    const reason = json.error_description || json.error || `${res.status}`;
    throw new GoogleTokenError(reason, json.error);
  }

  // Trim 60s off expires_in so we never hand back a token that expires mid-call.
  const ttlMs = Math.max(0, (json.expires_in ?? 3600) - 60) * 1000;
  return { token: json.access_token, expiresAt: new Date(Date.now() + ttlMs) };
}

export class GoogleTokenError extends Error {
  /** Google's machine-readable error code, e.g. "invalid_grant". */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'GoogleTokenError';
    this.code = code;
  }
}

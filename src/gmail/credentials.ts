/**
 * Gmail credentials resolver
 * ==========================
 * Loads a SupportChannelConnection (channelType=GMAIL), decrypts its refresh
 * token, and mints a fresh access token. Analogous to resolveShopifyConnection.
 * Used by watch.ts, send.ts, and the history/message fetcher.
 */

import { prisma } from '../prisma.js';
import { decryptTokenRef } from './crypto.js';
import { refreshAccessToken } from './oauth.js';

export type GmailConnection = {
  connectionId: string;
  organisationId: string;
  accountEmail: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
};

/**
 * Resolve a usable, freshly-minted access token for a Gmail SupportChannelConnection.
 * Always refreshes rather than caching — Gmail watch/history calls are
 * infrequent enough that the extra token round-trip is not worth a cache.
 */
export async function resolveGmailConnection(
  connectionId: string,
): Promise<GmailConnection> {
  const row = await prisma.supportChannelConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      organisationId: true,
      externalAccountId: true,
      refreshTokenRef: true,
    },
  });

  if (!row) throw new Error(`Gmail connection not found: ${connectionId}`);
  if (!row.refreshTokenRef) throw new Error(`Gmail connection ${connectionId} has no refresh token`);

  const refreshToken = decryptTokenRef(row.refreshTokenRef);
  const access = await refreshAccessToken(refreshToken);

  return {
    connectionId: row.id,
    organisationId: row.organisationId,
    accountEmail: row.externalAccountId,
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
  };
}

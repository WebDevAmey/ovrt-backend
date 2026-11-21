/**
 * Shopify Credentials
 * ===================
 * Decrypts the Shopify Admin API access token from ShopifyIntegration.accessToken
 * (AES-256-GCM, same "v1:<iv>:<tag>:<data>" format the frontend lib/crypto.ts
 * produces) and exposes a resolver that returns everything the agent needs to
 * make authenticated GraphQL calls.
 *
 * Required env var:
 *   DATASOURCE_ENC_KEY — same raw string used by the frontend and by warehouse
 *   credential decryption. The AES key is derived identically:
 *     sha256(DATASOURCE_ENC_KEY).digest()
 *
 * For local dev, a raw token starting with "shpat_" or "shpua_" is accepted
 * unencrypted so engineers can paste a real token without re-encrypting it.
 */

import { createDecipheriv, createHash } from 'node:crypto';
import { prisma } from '../../prisma.js';

// Admin API version used for the agent's GraphQL calls. Pinned to the same
// version selected for the Shopify app's Webhooks API (2025-07) so both
// surfaces match. We do not use ShopifyQL (it was removed in 2025-07) — all
// analytics happen via the stable `orders` / `products` / `customers`
// connections, which have been stable since 2022.
//
// NOTE: the OAuth access token is not bound to a specific Admin API version,
// so changing this constant does not require reinstalling the app.
export const SHOPIFY_API_VERSION = '2025-07';

function getEncryptionKey(): Buffer {
  const raw = process.env.DATASOURCE_ENC_KEY;
  if (!raw) throw new Error('DATASOURCE_ENC_KEY env var is not set');
  return createHash('sha256').update(raw).digest();
}

function decryptToken(encrypted: string): string {
  // Dev override: a real Shopify access token starts with shpat_ / shpua_ /
  // shpca_. If we see one of those, treat the field as already-plaintext.
  if (/^shp(at|ua|ca|ss)_/.test(encrypted)) return encrypted;

  const parts = encrypted.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error(
      `accessToken has unexpected format. Expected "v1:<iv>:<tag>:<data>" ` +
        `(AES-256-GCM from frontend encryptString). Got prefix: "${encrypted.slice(0, 20)}"`,
    );
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export type ShopifyConnectInfo = {
  integrationId: string;
  name: string;
  shopDomain: string;
  accessToken: string;
  currency: string | null;
  timezone: string | null;
  planName: string | null;
  shopName: string | null;
  primaryDomain: string | null;
  apiVersion: string;
  graphqlUrl: string;
};

// The scalar columns required to build a ShopifyConnectInfo. Exported so callers
// that already hold (or are about to fetch) the integration row can select
// exactly these and hand the row to buildShopifyConnection — avoiding a second
// round-trip to re-read the same row by id.
export const SHOPIFY_CONNECTION_SELECT = {
  id: true,
  name: true,
  shopDomain: true,
  accessToken: true,
  currency: true,
  timezone: true,
  planName: true,
  shopName: true,
  primaryDomain: true,
} as const;

type ShopifyConnectionRow = {
  id: string;
  name: string;
  shopDomain: string;
  accessToken: string;
  currency: string | null;
  timezone: string | null;
  planName: string | null;
  shopName: string | null;
  primaryDomain: string | null;
};

// Pure (no DB) builder: turns an already-loaded integration row into a
// connection, decrypting the token. Use this when you already have the row to
// avoid a redundant query.
export function buildShopifyConnection(row: ShopifyConnectionRow): ShopifyConnectInfo {
  const accessToken = decryptToken(row.accessToken);

  return {
    integrationId: row.id,
    name: row.name,
    shopDomain: row.shopDomain,
    accessToken,
    currency: row.currency,
    timezone: row.timezone,
    planName: row.planName,
    shopName: row.shopName,
    primaryDomain: row.primaryDomain,
    apiVersion: SHOPIFY_API_VERSION,
    graphqlUrl: `https://${row.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
  };
}

export async function resolveShopifyConnection(
  integrationId: string,
): Promise<ShopifyConnectInfo> {
  const row = await prisma.shopifyIntegration.findUnique({
    where: { id: integrationId },
    select: SHOPIFY_CONNECTION_SELECT,
  });

  if (!row) throw new Error(`Shopify integration not found: ${integrationId}`);

  return buildShopifyConnection(row);
}

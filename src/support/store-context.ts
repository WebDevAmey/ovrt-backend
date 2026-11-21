/**
 * Org → StoreContext resolver (channel-agnostic)
 * ===============================================
 * Resolves the org's active Shopify store into the channel-neutral StoreContext
 * the support brain expects, scoped to the conversation's customer handle.
 *
 * Critically, the customer email passed here must be the PARSED bare address
 * (e.g. `jane@acme.com`) — the channel adapter is responsible for normalising
 * the customer's raw handle into `customer.handle` before this point.
 */

import { prisma } from '../prisma.js';
import { resolveShopifyConnection } from '../agents/shopify/credentials.js';
import type { StoreContext } from './types.js';

/** Resolve the org's active Shopify store for the support agent, or null. */
export async function loadStoreContext(
  organisationId: string,
  customerEmail: string | null,
): Promise<StoreContext | null> {
  const integration = await prisma.shopifyIntegration.findFirst({
    where: { organisationId, status: 'ACTIVE' },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!integration) return null;

  try {
    const conn = await resolveShopifyConnection(integration.id);
    return { conn, shopName: conn.shopName ?? conn.name, customerEmail };
  } catch (err) {
    console.warn('[support-agent] Shopify credential resolution failed', {
      integrationId: integration.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

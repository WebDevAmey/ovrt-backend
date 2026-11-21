import { prisma } from '../../prisma.js';
import { resolveShopifyConnection } from '../../agents/shopify/credentials.js';
import type { ShopifyConnectInfo } from '../../agents/shopify/credentials.js';
import { BUSINESS_TIMEZONE } from '../constants.js';

export async function resolveShopifySource(orgId: string): Promise<string | null> {
  const integration = await prisma.shopifyIntegration.findFirst({
    where: { organisationId: orgId, status: 'ACTIVE' },
    select: { id: true },
  });
  return integration?.id ?? null;
}

export async function getShopifyConn(integrationId: string): Promise<ShopifyConnectInfo> {
  return resolveShopifyConnection(integrationId);
}

// Returns the calendar date N days before "today" in the business timezone
// (IST), formatted as YYYY-MM-DD. Anchoring on IST rather than the server's
// UTC clock keeps "last 7/30 days" windows aligned with the merchant's day.
export function daysAgoStr(n: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);

  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
}

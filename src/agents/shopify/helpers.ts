/**
 * Pure utility functions for Shopify data processing
 */

import { shopifyGraphQL } from './graphql.js';
import type { ShopifyConnectInfo } from './credentials.js';
import type { RecordResult, OrderPageNode, OrderPageResponse } from './types.js';

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

// Pagination ceiling for client-side aggregation. 8 pages × 250 = 2000 orders.
// Enough for almost any 30-day window for a typical merchant; large stores may
// see truncation flagged on the result.
const PAGE_SIZE = 250;
const MAX_AGGREGATE_PAGES = 8;

export function clamp(n: number | undefined, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n as number)));
}

export function rowsToResult(
  rows: Array<Record<string, unknown>>,
  truncated = false,
): RecordResult {
  return {
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rows,
    rowCount: rows.length,
    truncated,
  };
}

export function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

export function buildOrderQuery(opts: {
  since?: string | null;
  until?: string | null;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
}): string {
  const parts: string[] = [];
  if (opts.since) parts.push(`created_at:>='${opts.since}T00:00:00Z'`);
  if (opts.until) parts.push(`created_at:<='${opts.until}T23:59:59Z'`);
  if (opts.financialStatus) parts.push(`financial_status:${opts.financialStatus}`);
  if (opts.fulfillmentStatus) parts.push(`fulfillment_status:${opts.fulfillmentStatus}`);
  return parts.join(' ');
}

export function bucketKey(date: Date, granularity: 'day' | 'week' | 'month'): string {
  // Always UTC-rounded; report-day boundaries are good-enough for trend analysis.
  if (granularity === 'day') return date.toISOString().slice(0, 10);
  if (granularity === 'month') return date.toISOString().slice(0, 7);
  // week: ISO week key by Monday
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

export async function fetchOrderPages(
  conn: ShopifyConnectInfo,
  queryString: string,
  options: { includeLineItems: boolean; includeShippingAddress?: boolean; maxPages?: number },
): Promise<{ orders: OrderPageNode[]; truncated: boolean; currency: string | null }> {
  const lineItemsBlock = options.includeLineItems
    ? `
        lineItems(first: 50) {
          edges {
            node {
              title
              quantity
              originalUnitPriceSet { shopMoney { amount } }
            }
          }
        }`
    : '';

  const shippingAddressBlock = options.includeShippingAddress
    ? `
        shippingAddress { city country }`
    : '';
  // state (ENABLED/DISABLED/etc.) is only needed alongside shipping address
  // for region-level fraud-cluster detection — bundled under the same flag
  // since no other caller needs it.
  const customerBlock = options.includeShippingAddress ? 'customer { id state }' : 'customer { id }';

  const query = /* GraphQL */ `
    query OrderPage($first: Int!, $q: String, $after: String) {
      orders(first: $first, query: $q, after: $after, sortKey: CREATED_AT, reverse: false) {
        edges {
          cursor
          node {
            id
            createdAt
            displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalDiscountsSet { shopMoney { amount } }
            ${customerBlock}
            ${lineItemsBlock}
            ${shippingAddressBlock}
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const maxPages = options.maxPages ?? MAX_AGGREGATE_PAGES;
  const collected: OrderPageNode[] = [];
  let cursor: string | null = null;
  let currency: string | null = null;
  let page = 0;

  while (page < maxPages) {
    const data: OrderPageResponse = await shopifyGraphQL<OrderPageResponse>(conn, query, {
      first: PAGE_SIZE,
      q: queryString || null,
      after: cursor,
    });
    for (const edge of data.orders.edges) {
      collected.push(edge.node);
      if (!currency) currency = edge.node.currentTotalPriceSet.shopMoney.currencyCode;
    }
    page += 1;
    if (!data.orders.pageInfo.hasNextPage) {
      return { orders: collected, truncated: false, currency };
    }
    cursor = data.orders.pageInfo.endCursor;
    if (!cursor) break;
  }
  return { orders: collected, truncated: true, currency };
}

export const MAX_AGGREGATE_PAGES_EXPORT = MAX_AGGREGATE_PAGES;
export const PAGE_SIZE_EXPORT = PAGE_SIZE;
export const DEFAULT_LIST_LIMIT_EXPORT = DEFAULT_LIST_LIMIT;
export const MAX_LIST_LIMIT_EXPORT = MAX_LIST_LIMIT;

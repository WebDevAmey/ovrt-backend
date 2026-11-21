/**
 * Customer metrics: retention statistics
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult } from '../helpers.js';
import { queryCustomersWithRetention, MAX_CUSTOMER_PAGES, INVENTORY_PAGE_SIZE } from '../queries.js';

export type CustomerRetentionInput = {
  since?: string | null;
  until?: string | null;
};

export async function getCustomerRetentionStats(
  conn: ShopifyConnectInfo,
  input: CustomerRetentionInput,
): Promise<RecordResult> {
  const parts: string[] = [];
  if (input.since) parts.push(`customer_date:>='${input.since}T00:00:00Z'`);
  if (input.until) parts.push(`customer_date:<='${input.until}T23:59:59Z'`);
  const queryStr = parts.join(' ');

  type Brief = { orders: number; spent: number };
  const all: Brief[] = [];
  let cursor: string | null = null;
  let page = 0;
  let truncated = false;
  let currency = conn.currency ?? '';

  while (page < MAX_CUSTOMER_PAGES) {
    const data = await queryCustomersWithRetention(conn, INVENTORY_PAGE_SIZE, cursor, queryStr || null);

    for (const { node } of data.customers.edges) {
      if (!currency && node.amountSpent.currencyCode) currency = node.amountSpent.currencyCode;
      all.push({
        orders: parseInt(node.numberOfOrders, 10) || 0,
        spent: parseFloat(node.amountSpent.amount) || 0,
      });
    }

    page++;
    if (!data.customers.pageInfo.hasNextPage) break;
    if (page >= MAX_CUSTOMER_PAGES) { truncated = true; break; }
    cursor = data.customers.pageInfo.endCursor;
    if (!cursor) break;
  }

  const newC = all.filter((c) => c.orders === 1);
  const retC = all.filter((c) => c.orders > 1);
  const totalRevenue = all.reduce((s, c) => s + c.spent, 0);
  const newRevenue = newC.reduce((s, c) => s + c.spent, 0);
  const retRevenue = retC.reduce((s, c) => s + c.spent, 0);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  const row = {
    period: `${input.since ?? 'all time'} → ${input.until ?? 'now'}`,
    totalCustomers: all.length,
    newCustomers: newC.length,
    returningCustomers: retC.length,
    repeatPurchaseRate: all.length > 0 ? round2((retC.length / all.length) * 100) : 0,
    avgOrdersPerCustomer: all.length > 0 ? round2(all.reduce((s, c) => s + c.orders, 0) / all.length) : 0,
    avgLtv: all.length > 0 ? round2(totalRevenue / all.length) : 0,
    newCustomerAvgSpend: newC.length > 0 ? round2(newRevenue / newC.length) : 0,
    returningCustomerAvgLtv: retC.length > 0 ? round2(retRevenue / retC.length) : 0,
    currency,
    truncated,
  };
  return rowsToResult([row], truncated);
}

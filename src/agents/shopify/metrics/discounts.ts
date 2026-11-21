/**
 * Discount performance metrics: usage and effectiveness analysis
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult, isoDate, buildOrderQuery } from '../helpers.js';
import { queryOrdersWithDiscounts, INVENTORY_PAGE_SIZE, MAX_INVENTORY_PAGES } from '../queries.js';

export type DiscountPerformanceInput = {
  since: string;
  until?: string | null;
};

export async function getDiscountPerformance(
  conn: ShopifyConnectInfo,
  input: DiscountPerformanceInput,
): Promise<RecordResult> {
  const queryString = buildOrderQuery({
    since: input.since,
    until: input.until ?? isoDate(new Date()),
  });

  const codeMap = new Map<string, { uses: number; totalDiscount: number; totalRevenue: number }>();
  let totalOrders = 0;
  let ordersWithDiscount = 0;
  let totalDiscountAmount = 0;
  let currency = conn.currency ?? '';
  let cursor: string | null = null;
  let page = 0;
  let truncated = false;

  while (page < MAX_INVENTORY_PAGES) {
    const data = await queryOrdersWithDiscounts(conn, INVENTORY_PAGE_SIZE, queryString || null, cursor);

    for (const { node } of data.orders.edges) {
      if (!currency) currency = node.currentTotalPriceSet.shopMoney.currencyCode;
      totalOrders++;
      const revenue = parseFloat(node.currentTotalPriceSet.shopMoney.amount) || 0;
      const discount = node.totalDiscountsSet
        ? parseFloat(node.totalDiscountsSet.shopMoney.amount)
        : 0;

      if (node.discountCodes.length > 0) {
        ordersWithDiscount++;
        totalDiscountAmount += discount;
        for (const code of node.discountCodes) {
          const existing = codeMap.get(code) ?? { uses: 0, totalDiscount: 0, totalRevenue: 0 };
          existing.uses++;
          existing.totalDiscount += discount;
          existing.totalRevenue += revenue;
          codeMap.set(code, existing);
        }
      }
    }

    page++;
    if (!data.orders.pageInfo.hasNextPage) break;
    if (page >= MAX_INVENTORY_PAGES) { truncated = true; break; }
    cursor = data.orders.pageInfo.endCursor;
    if (!cursor) break;
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  const topCodes = Array.from(codeMap.entries())
    .sort((a, b) => b[1].uses - a[1].uses)
    .slice(0, 20)
    .map(([code, v]) => ({
      code,
      timesUsed: v.uses,
      totalDiscount: round2(v.totalDiscount),
      totalRevenue: round2(v.totalRevenue),
      avgDiscountPerOrder: v.uses > 0 ? round2(v.totalDiscount / v.uses) : 0,
    }));

  const summaryRow: Record<string, unknown> = {
    rowType: 'summary',
    since: input.since,
    until: input.until ?? isoDate(new Date()),
    totalOrders,
    ordersWithDiscount,
    discountUptakeRate: totalOrders > 0 ? round2((ordersWithDiscount / totalOrders) * 100) : 0,
    totalDiscountGiven: round2(totalDiscountAmount),
    currency,
    truncated,
  };

  return rowsToResult([summaryRow, ...topCodes], truncated);
}

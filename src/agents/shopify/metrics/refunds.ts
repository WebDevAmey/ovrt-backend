/**
 * Refund metrics: refund analysis and product return patterns
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult, isoDate, buildOrderQuery } from '../helpers.js';
import { queryOrdersWithRefunds, INVENTORY_PAGE_SIZE, MAX_INVENTORY_PAGES } from '../queries.js';

export type RefundAnalysisInput = {
  since: string;
  until?: string | null;
};

export async function getRefundAnalysis(
  conn: ShopifyConnectInfo,
  input: RefundAnalysisInput,
): Promise<RecordResult> {
  const queryString = buildOrderQuery({
    since: input.since,
    until: input.until ?? isoDate(new Date()),
  });

  let totalOrders = 0;
  let refundedOrders = 0;
  let totalRefunded = 0;
  let totalRevenue = 0;
  let currency = conn.currency ?? '';
  const productRefunds = new Map<string, { count: number; qty: number }>();
  let cursor: string | null = null;
  let page = 0;
  let truncated = false;

  while (page < MAX_INVENTORY_PAGES) {
    const data = await queryOrdersWithRefunds(conn, INVENTORY_PAGE_SIZE, queryString || null, cursor);

    for (const { node } of data.orders.edges) {
      if (!currency) currency = node.currentTotalPriceSet.shopMoney.currencyCode;
      totalOrders++;
      totalRevenue += parseFloat(node.currentTotalPriceSet.shopMoney.amount) || 0;

      if (node.refunds.length > 0) {
        refundedOrders++;
        for (const refund of node.refunds) {
          totalRefunded += parseFloat(refund.totalRefundedSet.shopMoney.amount) || 0;
          for (const rliEdge of refund.refundLineItems.edges) {
            const title = rliEdge.node.lineItem?.title ?? '(unknown)';
            const existing = productRefunds.get(title) ?? { count: 0, qty: 0 };
            existing.count++;
            existing.qty += rliEdge.node.quantity;
            productRefunds.set(title, existing);
          }
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

  const topRefunded = Array.from(productRefunds.entries())
    .sort((a, b) => b[1].qty - a[1].qty)
    .slice(0, 10)
    .map(([title, v]) => ({
      rowType: 'product',
      product: title,
      refundOccurrences: v.count,
      unitsRefunded: v.qty,
    }));

  const summaryRow: Record<string, unknown> = {
    rowType: 'summary',
    since: input.since,
    until: input.until ?? isoDate(new Date()),
    totalOrders,
    ordersWithRefunds: refundedOrders,
    refundRate: totalOrders > 0 ? round2((refundedOrders / totalOrders) * 100) : 0,
    totalRefunded: round2(totalRefunded),
    totalRevenue: round2(totalRevenue),
    refundAsPercentOfRevenue: totalRevenue > 0 ? round2((totalRefunded / totalRevenue) * 100) : 0,
    currency,
    truncated,
  };

  return rowsToResult([summaryRow, ...topRefunded], truncated);
}

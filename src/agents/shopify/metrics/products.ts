/**
 * Product metrics: top products by sales
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult, isoDate, clamp, buildOrderQuery, fetchOrderPages } from '../helpers.js';

export type TopProductsInput = {
  since: string;
  until?: string | null;
  limit?: number;
};

export async function getTopProductsBySales(
  conn: ShopifyConnectInfo,
  input: TopProductsInput,
): Promise<RecordResult> {
  const queryString = buildOrderQuery({
    since: input.since,
    until: input.until ?? isoDate(new Date()),
  });
  const { orders, truncated, currency } = await fetchOrderPages(conn, queryString, {
    includeLineItems: true,
  });

  const agg = new Map<string, { units: number; revenue: number }>();
  for (const o of orders) {
    for (const e of o.lineItems?.edges ?? []) {
      const title = e.node.title;
      const qty = e.node.quantity;
      const unit = e.node.originalUnitPriceSet ? Number(e.node.originalUnitPriceSet.shopMoney.amount) : 0;
      const cur = agg.get(title) ?? { units: 0, revenue: 0 };
      cur.units += qty;
      cur.revenue += qty * unit;
      agg.set(title, cur);
    }
  }

  const limit = clamp(input.limit, 1, 50, 10);
  const rows = Array.from(agg.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, limit)
    .map(([title, v]) => ({
      product: title,
      units: v.units,
      revenue: Math.round(v.revenue * 100) / 100,
      currency,
    }));

  return rowsToResult(rows, truncated);
}

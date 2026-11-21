import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getDiscountPerformance } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type DiscountRow = {
  windowStart: string;
  windowEnd: string;
  totalOrders: number;
  ordersWithDiscount: number;
  discountUptakeRate: number; // percentage
  totalDiscountGiven: number;
  currency: string;
};

// 8 non-overlapping 7-day windows. ewmaProportionControl needs real history
// to size its control limit by sample volume — a single WoW comparison
// can't tell "5pp move on 15 orders" (noise) from "5pp move on 150 orders"
// (signal).
const SNAPSHOT_COUNT = 8;
const WINDOW_DAYS = 7;

export async function fetchDiscountWindows(integrationId: string): Promise<DiscountRow[]> {
  const conn = await getShopifyConn(integrationId);

  const offsets = Array.from({ length: SNAPSHOT_COUNT }, (_, i) => i * WINDOW_DAYS);
  const results = await Promise.all(
    offsets.map((offset) =>
      getDiscountPerformance(conn, {
        since: daysAgoStr(WINDOW_DAYS + offset),
        until: daysAgoStr(1 + offset),
      }),
    ),
  );

  const rows = offsets.map((offset, idx) => {
    const r = results[idx]!;
    const s = r.rows.find((row) => (row as Record<string, unknown>).rowType === 'summary') as
      | Record<string, unknown>
      | undefined;
    return {
      windowStart: daysAgoStr(WINDOW_DAYS + offset),
      windowEnd: daysAgoStr(1 + offset),
      totalOrders: Number(s?.totalOrders ?? 0),
      ordersWithDiscount: Number(s?.ordersWithDiscount ?? 0),
      discountUptakeRate: Number(s?.discountUptakeRate ?? 0),
      totalDiscountGiven: Number(s?.totalDiscountGiven ?? 0),
      currency: String(s?.currency ?? ''),
    };
  });

  return rows.reverse(); // ascending chronological order
}

import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getCheckoutAbandonment } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type CheckoutAbandonmentRow = {
  windowStart: string;
  windowEnd: string;
  abandonedCheckouts: number;
  completedCheckouts: number;
  totalCheckouts: number;
  abandonmentRate: number; // percentage (0-100)
  abandonedValue: number;  // estimated total cart value of abandoned carts
  currency: string;
};

// 8 non-overlapping 7-day windows. ewmaProportionControl needs real history
// to size its control limit by sample volume, rather than a flat percentage-
// point jump that reads the same regardless of how many checkouts it's
// based on.
const SNAPSHOT_COUNT = 8;
const WINDOW_DAYS = 7;

export async function fetchCheckoutAbandonment(integrationId: string): Promise<CheckoutAbandonmentRow[]> {
  const conn = await getShopifyConn(integrationId);

  const offsets = Array.from({ length: SNAPSHOT_COUNT }, (_, i) => i * WINDOW_DAYS);
  const results = await Promise.all(
    offsets.map((offset) =>
      getCheckoutAbandonment(conn, {
        since: daysAgoStr(WINDOW_DAYS + offset),
        until: daysAgoStr(1 + offset),
      }),
    ),
  );

  const rows = offsets.map((offset, idx) => {
    const r = results[idx]!;
    const s = r.rows[0] as Record<string, unknown>;
    return {
      windowStart: daysAgoStr(WINDOW_DAYS + offset),
      windowEnd: daysAgoStr(1 + offset),
      abandonedCheckouts: Number(s?.abandonedCheckouts ?? 0),
      completedCheckouts: Number(s?.completedCheckouts ?? 0),
      totalCheckouts: Number(s?.totalCheckouts ?? 0),
      abandonmentRate: Number(s?.abandonmentRate ?? 0),
      abandonedValue: Number(s?.abandonedValue ?? 0),
      currency: String(s?.currency ?? ''),
    };
  });

  return rows.reverse(); // ascending chronological order
}

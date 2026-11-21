import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getCustomerRetentionStats } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type RetentionRow = {
  windowStart: string;
  windowEnd: string;
  totalCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  repeatPurchaseRate: number; // percentage (0-100)
  avgOrdersPerCustomer: number;
  avgLtv: number;
  currency: string;
};

// 8 weekly snapshots of the trailing 30-day repeat-purchase rate, each
// offset by 7 days. ewmaProportionControl needs a real history (not just a
// single prior period) to build a control limit that accounts for sample
// size — a single MoM comparison can't distinguish "4pp move on 30
// customers" (noise) from "4pp move on 300 customers" (signal).
const SNAPSHOT_COUNT = 8;
const WINDOW_DAYS = 30;
const STEP_DAYS = 7;

export async function fetchRetentionWindows(integrationId: string): Promise<RetentionRow[]> {
  const conn = await getShopifyConn(integrationId);

  const offsets = Array.from({ length: SNAPSHOT_COUNT }, (_, i) => i * STEP_DAYS);
  const results = await Promise.all(
    offsets.map((offset) =>
      getCustomerRetentionStats(conn, {
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
      totalCustomers: Number(s.totalCustomers ?? 0),
      newCustomers: Number(s.newCustomers ?? 0),
      returningCustomers: Number(s.returningCustomers ?? 0),
      repeatPurchaseRate: Number(s.repeatPurchaseRate ?? 0),
      avgOrdersPerCustomer: Number(s.avgOrdersPerCustomer ?? 0),
      avgLtv: Number(s.avgLtv ?? 0),
      currency: String(s.currency ?? ''),
    };
  });

  // Ascending chronological order (oldest snapshot first) for the EWMA series.
  return rows.reverse();
}

import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getOrdersTimeSeries } from '../../../agents/shopify/functions.js';
import type { DailyOrderRow } from './detector.js';

export { resolveShopifySource };

// 9 weeks: enough for seasonalCusum's day-of-week baselines (8 weeks of
// history per weekday) plus the most recent 7-day test window.
const LOOKBACK_DAYS = 63;

/**
 * Fetches 63 days of daily order counts from Shopify.
 * Returns exactly 63 rows in ascending date order, with zero-fills for days
 * that had no orders. Without the zero-fill, getOrdersTimeSeries omits empty
 * days, making rows.length < 63 and silently suppressing CUSUM detection
 * for any store that had a quiet day in the baseline window.
 */
export async function fetchDailyOrders(integrationId: string): Promise<DailyOrderRow[]> {
  const conn = await getShopifyConn(integrationId);

  const since = daysAgoStr(LOOKBACK_DAYS);
  const until = daysAgoStr(1);

  const result = await getOrdersTimeSeries(conn, {
    since,
    until,
    granularity: 'day',
  });

  type Bucket = { period: string; orderCount: number; sales: number; currency: string };
  const buckets = result.rows as Bucket[];
  const byDate = new Map(buckets.map((b) => [b.period, b]));
  const currency = buckets[0]?.currency ?? '';

  // Build exactly LOOKBACK_DAYS rows, inserting zero rows for any date that
  // had no orders. Shopify omits empty days from the time series.
  const rows: DailyOrderRow[] = [];
  for (let i = LOOKBACK_DAYS; i >= 1; i--) {
    const date = daysAgoStr(i);
    const b = byDate.get(date);
    rows.push({
      period: date,
      orderCount: b?.orderCount ?? 0,
      sales: b?.sales ?? 0,
      currency: b?.currency ?? currency,
    });
  }

  return rows;
}

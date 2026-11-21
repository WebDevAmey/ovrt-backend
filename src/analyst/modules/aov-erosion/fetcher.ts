import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getOrdersTimeSeries } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type AovRow = {
  period: string; // YYYY-MM-DD
  orderCount: number;
  sales: number;
  averageOrderValue: number;
  currency: string;
};

// 9 weeks: enough for seasonalCusum's day-of-week baselines (8 weeks of
// history per weekday) plus the most recent 7-day test window.
const LOOKBACK_DAYS = 63;

/**
 * Fetches 63 days of daily AOV (paid orders only) from Shopify.
 * financial_status:paid excludes refunded/voided orders, since
 * currentTotalPriceSet is net of refunds and would otherwise silently
 * deflate AOV on a day with no real erosion. Zero-fills days with no paid
 * orders (averageOrderValue: 0) — seasonalCusum's day-of-week grouping
 * tolerates the occasional zero day.
 */
export async function fetchDailyAov(integrationId: string): Promise<AovRow[]> {
  const conn = await getShopifyConn(integrationId);

  const since = daysAgoStr(LOOKBACK_DAYS);
  const until = daysAgoStr(1);

  const result = await getOrdersTimeSeries(conn, {
    since,
    until,
    granularity: 'day',
    financialStatus: 'paid',
  });

  type Bucket = { period: string; orderCount: number; sales: number; currency: string };
  const buckets = result.rows as Bucket[];
  const byDate = new Map(buckets.map((b) => [b.period, b]));
  const currency = buckets[0]?.currency ?? '';

  const rows: AovRow[] = [];
  for (let i = LOOKBACK_DAYS; i >= 1; i--) {
    const date = daysAgoStr(i);
    const b = byDate.get(date);
    const orderCount = b?.orderCount ?? 0;
    const sales = b?.sales ?? 0;
    rows.push({
      period: date,
      orderCount,
      sales,
      averageOrderValue: orderCount > 0 ? sales / orderCount : 0,
      currency: b?.currency ?? currency,
    });
  }

  return rows;
}

import { resolveShopifySource, getShopifyConn } from '../shopify-shared.js';
import { getOrdersTimeSeries } from '../../../agents/shopify/functions.js';
import { BUSINESS_TIMEZONE } from '../../constants.js';

export { resolveShopifySource };

export type WeeklyRevenueRow = {
  weekStart: string;  // YYYY-MM-DD of Monday
  weekEnd: string;    // YYYY-MM-DD of Sunday
  revenue: number;
  orderCount: number;
  currency: string;
};

const WEEKS = 12;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Builds the date range for exactly 12 complete ISO weeks ending last Sunday.
 *
 * The schedule runs at Monday 04:00 IST. At that moment, the most recent
 * complete week is the prior Monday→Sunday. We anchor on that Sunday so the
 * trend isn't skewed by a partial in-flight week.
 *
 * "Today" is resolved in the business timezone (IST) — not the server's UTC
 * clock — so the week boundary matches the merchant's calendar.
 *
 * Returned dates are inclusive on both ends.
 */
function computeWindow(now: Date): {
  startMonday: string;
  endSunday: string;
  weekStarts: string[];
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);

  const todayUTC = new Date(Date.UTC(y, m - 1, d));
  // 0=Sun,1=Mon,...6=Sat. We want the last Sunday strictly before "today".
  const dow = todayUTC.getUTCDay();
  const daysToLastSunday = dow === 0 ? 7 : dow;
  const lastSunday = new Date(todayUTC);
  lastSunday.setUTCDate(todayUTC.getUTCDate() - daysToLastSunday);

  // Monday of the week 11 weeks before lastSunday's week → 12 complete weeks total
  const startMonday = new Date(lastSunday);
  startMonday.setUTCDate(lastSunday.getUTCDate() - (WEEKS * 7 - 1));

  const weekStarts: string[] = [];
  for (let i = 0; i < WEEKS; i++) {
    const d = new Date(startMonday);
    d.setUTCDate(startMonday.getUTCDate() + i * 7);
    weekStarts.push(toIsoDate(d));
  }

  return {
    startMonday: toIsoDate(startMonday),
    endSunday: toIsoDate(lastSunday),
    weekStarts,
  };
}

export async function fetchWeeklyRevenue(integrationId: string): Promise<WeeklyRevenueRow[]> {
  const conn = await getShopifyConn(integrationId);
  const { startMonday, endSunday, weekStarts } = computeWindow(new Date());

  const result = await getOrdersTimeSeries(conn, {
    since: startMonday,
    until: endSunday,
    granularity: 'week',
  });

  // The time series buckets by ISO-week Monday key. Empty weeks are absent;
  // fill them with zeros so the regression sees a uniformly spaced series.
  type Bucket = { period: string; orderCount: number; sales: number; currency: string };
  const buckets = result.rows as Bucket[];
  const byKey = new Map(buckets.map((b) => [b.period, b]));
  const currency = buckets[0]?.currency ?? '';

  const rows: WeeklyRevenueRow[] = weekStarts.map((mondayKey) => {
    const bucket = byKey.get(mondayKey);
    const sundayDate = new Date(`${mondayKey}T00:00:00Z`);
    sundayDate.setUTCDate(sundayDate.getUTCDate() + 6);
    return {
      weekStart: mondayKey,
      weekEnd: toIsoDate(sundayDate),
      revenue: bucket?.sales ?? 0,
      orderCount: bucket?.orderCount ?? 0,
      currency: bucket?.currency ?? currency,
    };
  });

  return rows;
}

// Exposed for unit tests / debugging if needed
export { computeWindow };

import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { AovRow } from './fetcher.js';
import { seasonalCusum } from '../stats.js';

// Day-of-week-adjusted CUSUM on daily AOV (paid orders only) over 63 days.
//
// The prior approach compared two raw 7-day windows and fired on a flat 10%
// drop — noisy at low weekly order counts and blind to a slow multi-day
// erosion that never produces a single sharp week-over-week dip. CUSUM
// standardizes each day against its own weekday's AOV baseline and
// accumulates the deviation, so a sustained decline shows up even though no
// single day looks dramatic.
//
// Days with zero paid orders carry no AOV signal (not "$0 baskets") and are
// excluded before standardization.
export function detectAovErosion(rows: FactRow[]): DetectionResult {
  const typedRows = rows as AovRow[];
  const withOrders = typedRows.filter((r) => r.orderCount > 0);
  if (withOrders.length < 21) return { detected: false };

  const result = seasonalCusum(
    withOrders.map((r) => ({ date: r.period, value: r.averageOrderValue })),
  );

  // AOV erosion is specifically about spending less per visit, not buying
  // less often (that's DAILY_ORDERS_TREND) — only surface drops here.
  if (!result.fired || result.direction !== 'drop') return { detected: false };

  const latest = withOrders[withOrders.length - 1]!;
  const dropPct =
    result.weekdayMean > 0
      ? ((result.weekdayMean - result.latestValue) / result.weekdayMean) * 100
      : 0;

  const anomaly: AnomalyDetails = {
    zScore: result.cusumValue,
    mean: result.weekdayMean,
    stdDev: result.weekdayStdDev,
    actualValue: result.latestValue,
    date: latest.period,
    direction: 'drop',
    dropPct: Math.round(dropPct * 100) / 100,
    currency: latest.currency,
  };

  return { detected: true, anomaly };
}

import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import { seasonalCusum } from '../stats.js';

export type DailyOrderRow = {
  period: string; // YYYY-MM-DD
  orderCount: number;
  sales: number;
  currency: string;
};

/**
 * Day-of-week-adjusted CUSUM on a 63-day daily order time series.
 *
 * A flat 13-day z-score (the prior approach) compares yesterday to a
 * baseline that includes every weekday equally — so a normal Monday spike
 * reads as anomalous against a baseline diluted by quiet Sundays, and a slow
 * multi-day decline never crosses the single-day threshold. seasonalCusum
 * fixes both: it standardizes each day against its own weekday's baseline,
 * then accumulates the standardized residual over time so sustained drift
 * shows up even when no single day is extreme.
 *
 * Requires the full 63-day series (see fetcher.ts); fires fewer than that,
 * detection is skipped (new store or data gaps).
 */
export function detectDailyOrdersOutlier(rows: FactRow[]): DetectionResult {
  const typedRows = rows as DailyOrderRow[];
  if (typedRows.length < 63) {
    return { detected: false };
  }

  const result = seasonalCusum(
    typedRows.map((r) => ({ date: r.period, value: r.orderCount })),
  );

  if (!result.fired) {
    return { detected: false };
  }

  const anomaly: AnomalyDetails = {
    zScore: result.cusumValue,
    mean: result.weekdayMean,
    stdDev: result.weekdayStdDev,
    actualValue: result.latestValue,
    date: typedRows[typedRows.length - 1]!.period,
    direction: result.direction,
  };

  return { detected: true, anomaly };
}

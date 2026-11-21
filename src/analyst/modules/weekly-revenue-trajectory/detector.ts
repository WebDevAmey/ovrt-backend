import type { DetectionResult, FactRow } from '../types.js';
import type { WeeklyRevenueRow } from './fetcher.js';
import { olsRegression, type Regression } from '../stats.js';

export { olsRegression };
export type { Regression };

// Linear regression on 12 weeks of revenue.
//
// We fire when ALL of:
//   1. Mean weekly revenue is meaningful (>= MIN_AVG_WEEKLY_REVENUE), so we
//      don't generate hooks for stores with negligible volume.
//   2. The trend is large in relative terms — |slope| / meanY > RELATIVE_SLOPE_THRESHOLD
//      per week. At 2%/week, that's ~25% drift over 12 weeks.
//   3. The trend is consistent — R² >= R_SQUARED_THRESHOLD, so wild week-to-week
//      noise that happens to net to a slope doesn't fire.
//
// Daily z-score (DAILY_ORDERS_TREND) misses slow declines — a 2%/week drop is
// completely invisible in day-over-day comparisons but is catastrophic over a
// quarter. This module is the long-horizon companion.
const MIN_AVG_WEEKLY_REVENUE = 500;
const RELATIVE_SLOPE_THRESHOLD = 0.02; // 2% per week
const R_SQUARED_THRESHOLD = 0.4;

const linearRegression = olsRegression;

export function detectWeeklyRevenueTrajectory(rows: FactRow[]): DetectionResult {
  const weeks = rows as WeeklyRevenueRow[];
  if (weeks.length < 12) return { detected: false };

  const reg = linearRegression(weeks.map((w) => w.revenue));

  if (reg.meanY < MIN_AVG_WEEKLY_REVENUE) return { detected: false };
  if (Math.abs(reg.relativeSlope) < RELATIVE_SLOPE_THRESHOLD) return { detected: false };
  if (reg.rSquared < R_SQUARED_THRESHOLD) return { detected: false };

  const direction = reg.slope > 0 ? 'spike' : 'drop';
  const totalImpliedChangePct = reg.relativeSlope * (weeks.length - 1) * 100;
  const lastWeek = weeks[weeks.length - 1]!;

  // AnomalyDetails contract (see modules/NOTES.md): the synthesis-time hook
  // formatter renders mean→baseline, actualValue→observed, and
  // (actualValue-mean)/|mean| → "% from baseline". For a TRAJECTORY the
  // meaningful "% from baseline" is the total trend change across the window,
  // not last week vs the 12-week mean. So we express baseline = predicted
  // first-week revenue (intercept) and observed = predicted last-week revenue
  // (fitted, not raw, so noise in the final week doesn't distort the trend).
  // Both are currency, same unit, and their ratio reproduces totalImpliedChangePct.
  const fittedFirst = reg.intercept;
  const fittedLast = reg.intercept + reg.slope * (weeks.length - 1);

  return {
    detected: true,
    anomaly: {
      // zScore reused as R² (trend consistency, [0,1]) — NOT a statistical σ.
      // stdDev stays 0; the hook prints this as "Nσ" which for this module
      // should be read as fit strength, surfaced explicitly in buildPromptContext.
      zScore: Math.round(reg.rSquared * 1000) / 1000,
      mean: Math.round(fittedFirst * 100) / 100,
      stdDev: 0,
      actualValue: Math.round(fittedLast * 100) / 100,
      date: lastWeek.weekEnd,
      direction,
      slopePerWeek: Math.round(reg.slope * 100) / 100,
      relativeSlopePct: Math.round(reg.relativeSlope * 10000) / 100,
      rSquared: Math.round(reg.rSquared * 1000) / 1000,
      totalImpliedChangePct: Math.round(totalImpliedChangePct * 10) / 10,
      // The actual arithmetic mean of the 12 weekly revenue values — distinct
      // from `mean` above, which holds the regression's fitted first-week
      // value for the same-unit hook contract. buildPromptContext must use
      // THIS field for any text that says "mean weekly revenue".
      meanWeeklyRevenue: Math.round(reg.meanY * 100) / 100,
      weeksObserved: weeks.length,
      currency: lastWeek.currency,
      firstWeekStart: weeks[0]!.weekStart,
      lastWeekEnd: lastWeek.weekEnd,
    },
  };
}

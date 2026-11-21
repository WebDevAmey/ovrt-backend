import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { RetentionRow } from './fetcher.js';
import { ewmaProportionControl } from '../stats.js';

// EWMA control chart on 8 weekly snapshots of the trailing-30-day repeat
// purchase rate.
//
// The prior approach fired on any 4pp month-over-month drop regardless of
// sample size — on 30 customers, binomial noise alone produces swings of
// that size routinely. ewmaProportionControl widens its control limit when
// the sample is small and narrows it when the sample is large, so the same
// 4pp move reads very differently depending on totalCustomers.
//
// This remains a leading indicator — retention decay surfaces here before
// it shows up in revenue, since churned customers take time to stop
// repurchasing.
export function detectRepeatPurchaseRateDrop(rows: FactRow[]): DetectionResult {
  const typedRows = rows as RetentionRow[];
  const usable = typedRows.filter((r) => r.totalCustomers >= 30);
  if (usable.length < 4) return { detected: false };

  const result = ewmaProportionControl(
    usable.map((r) => ({
      date: r.windowEnd,
      successes: r.returningCustomers,
      total: r.totalCustomers,
    })),
  );

  // Only retention DROPS are an anomaly worth surfacing here.
  if (!result.fired || result.direction !== 'drop') return { detected: false };

  const curr = usable[usable.length - 1]!;
  const baselineRatePct = result.ewma * 100;
  const currentRatePct = result.latestProportion * 100;
  const dropPp = baselineRatePct - currentRatePct;

  const anomaly: AnomalyDetails = {
    zScore: Math.round(((currentRatePct - baselineRatePct) / Math.max(baselineRatePct, 1)) * 100) / 100,
    mean: Math.round(baselineRatePct * 100) / 100,
    stdDev: 0,
    actualValue: Math.round(currentRatePct * 100) / 100,
    date: curr.windowEnd,
    direction: 'drop',
    dropPp: Math.round(dropPp * 100) / 100,
    currentWindow: `${curr.windowStart} → ${curr.windowEnd}`,
    currentReturning: curr.returningCustomers,
    currentTotal: curr.totalCustomers,
    controlLimitLowerPct: Math.round(result.controlLimitLower * 10000) / 100,
  };

  return { detected: true, anomaly };
}

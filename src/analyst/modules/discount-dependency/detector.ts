import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { DiscountRow } from './fetcher.js';
import { ewmaProportionControl } from '../stats.js';

// EWMA control chart on 8 weekly snapshots of discount uptake rate.
//
// The prior approach fired on any 5pp WoW rise above a flat 15% floor —
// scale-insensitive (a 5pp move at 8%→13% uptake isn't the same signal as
// 35%→40%) and noisy at low order counts. ewmaProportionControl sizes its
// control limit by each week's actual order volume.
export function detectDiscountDependencyCreep(rows: FactRow[]): DetectionResult {
  const typedRows = rows as DiscountRow[];
  const usable = typedRows.filter((r) => r.totalOrders >= 15);
  if (usable.length < 4) return { detected: false };

  const result = ewmaProportionControl(
    usable.map((r) => ({
      date: r.windowEnd,
      successes: r.ordersWithDiscount,
      total: r.totalOrders,
    })),
  );

  // Only rising dependency is the concern here — a drop in uptake isn't a
  // margin-erosion risk.
  if (!result.fired || result.direction !== 'spike') return { detected: false };

  const curr = usable[usable.length - 1]!;
  const baselinePct = result.ewma * 100;
  const currentPct = result.latestProportion * 100;

  const anomaly: AnomalyDetails = {
    zScore: Math.round(((currentPct - baselinePct) / Math.max(baselinePct, 1)) * 100) / 100,
    mean: Math.round(baselinePct * 100) / 100,
    stdDev: 0,
    actualValue: Math.round(currentPct * 100) / 100,
    date: curr.windowEnd,
    direction: 'spike',
    deltaPp: Math.round((currentPct - baselinePct) * 100) / 100,
    currentWindow: `${curr.windowStart} → ${curr.windowEnd}`,
    currentOrdersWithDiscount: curr.ordersWithDiscount,
    currentTotalOrders: curr.totalOrders,
    totalDiscountGiven: curr.totalDiscountGiven,
    currency: curr.currency,
  };

  return { detected: true, anomaly };
}

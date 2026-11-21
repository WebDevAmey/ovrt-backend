import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { CheckoutAbandonmentRow } from './fetcher.js';
import { ewmaProportionControl } from '../stats.js';

// EWMA control chart on 8 weekly snapshots of checkout abandonment rate.
//
// The prior approach fired on any flat 8pp WoW jump above a 50% floor —
// undocumented as a heuristic and insensitive to sample size. A real shift
// usually means something broke (payment gateway, mobile regression,
// surprise shipping cost); ewmaProportionControl's control limit naturally
// widens for low-volume weeks and narrows for high-volume ones.
const MIN_CHECKOUTS = 30;

export function detectCheckoutAbandonmentSpike(rows: FactRow[]): DetectionResult {
  const typedRows = rows as CheckoutAbandonmentRow[];
  const usable = typedRows.filter((r) => r.totalCheckouts >= MIN_CHECKOUTS);
  if (usable.length < 4) return { detected: false };

  const result = ewmaProportionControl(
    usable.map((r) => ({
      date: r.windowEnd,
      successes: r.abandonedCheckouts,
      total: r.totalCheckouts,
    })),
  );

  // A drop in abandonment is great news, not an anomaly worth surfacing.
  if (!result.fired || result.direction !== 'spike') return { detected: false };

  const curr = usable[usable.length - 1]!;
  const prev = usable[usable.length - 2]!;
  const baselinePct = result.ewma * 100;
  const currentPct = result.latestProportion * 100;

  // Estimated lost revenue assumes the EXCESS abandoned carts (beyond what
  // baseline rate would predict for this week's volume) would have
  // converted at the prior week's conversion rate. Order-of-magnitude, not
  // precise.
  const expectedAbandoned = result.ewma * curr.totalCheckouts;
  const excessAbandoned = Math.max(0, curr.abandonedCheckouts - expectedAbandoned);
  const avgCartValue = curr.abandonedCheckouts > 0 ? curr.abandonedValue / curr.abandonedCheckouts : 0;
  const estimatedLostRevenue = excessAbandoned * avgCartValue;

  const anomaly: AnomalyDetails = {
    zScore: Math.round(((currentPct - baselinePct) / Math.max(baselinePct, 1)) * 100) / 100,
    mean: Math.round(baselinePct * 100) / 100,
    stdDev: 0,
    actualValue: Math.round(currentPct * 100) / 100,
    date: curr.windowEnd,
    direction: 'spike',
    jumpPp: Math.round((currentPct - baselinePct) * 100) / 100,
    currentWindow: `${curr.windowStart} → ${curr.windowEnd}`,
    currentAbandoned: curr.abandonedCheckouts,
    previousAbandoned: prev.abandonedCheckouts,
    currentCompleted: curr.completedCheckouts,
    avgCartValue: Math.round(avgCartValue * 100) / 100,
    estimatedLostRevenue: Math.round(estimatedLostRevenue * 100) / 100,
    currency: curr.currency,
  };

  return { detected: true, anomaly };
}

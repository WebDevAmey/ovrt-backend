import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { RegionWeekSnapshot } from './fetcher.js';
import { ewmaProportionControl } from '../stats.js';

// Per-region EWMA control chart on order-share (orders shipping to a region
// ÷ all orders that week). Distinguishes a real regional shift (marketing
// campaign, seasonal pattern, shipping disruption) from noise, the same way
// the other rate-based modules do — sample-size-aware control limits rather
// than a flat percentage-point threshold.
//
// Secondary fraud-cluster signal: when the triggering region's share of
// orders from DISABLED customer accounts is notably elevated vs. the
// org-wide rate in the same week, flag it — a region growing because of
// fraud looks very different from one growing organically.
const MIN_ORDERS_PER_SNAPSHOT = 20; // org-wide total orders that week, for the region's proportion to be meaningful
const FRAUD_RATE_MULTIPLE = 2;
const FRAUD_MIN_DISABLED_ORDERS = 2;

export function detectGeographicDemandShift(rows: FactRow[]): DetectionResult {
  const typed = rows as RegionWeekSnapshot[];
  if (typed.length === 0) return { detected: false };

  const byRegion = new Map<string, RegionWeekSnapshot[]>();
  for (const r of typed) {
    const list = byRegion.get(r.region) ?? [];
    list.push(r);
    byRegion.set(r.region, list);
  }

  let worst: { region: string; result: ReturnType<typeof ewmaProportionControl>; latest: RegionWeekSnapshot } | null = null;

  for (const [region, snapshots] of byRegion) {
    const usable = snapshots
      .filter((s) => s.totalOrdersInWindow >= MIN_ORDERS_PER_SNAPSHOT)
      .sort((a, b) => (a.windowEnd < b.windowEnd ? -1 : 1));
    if (usable.length < 4) continue;

    const result = ewmaProportionControl(
      usable.map((s) => ({
        date: s.windowEnd,
        successes: s.orderCount,
        total: s.totalOrdersInWindow,
      })),
    );

    if (result.fired && result.direction === 'spike') {
      const deviation = result.latestProportion - result.ewma;
      const worstDeviation = worst ? worst.result.latestProportion - worst.result.ewma : -Infinity;
      if (deviation > worstDeviation) {
        worst = { region, result, latest: usable[usable.length - 1]! };
      }
    }
  }

  if (!worst) return { detected: false };

  // Fraud-cluster check: compare the triggering region's disabled-customer
  // order rate this week against the org-wide rate the same week.
  const latestWindowEnd = worst.latest.windowEnd;
  const sameWeekSnapshots = typed.filter((r) => r.windowEnd === latestWindowEnd);
  const orgWideOrders = worst.latest.totalOrdersInWindow;
  const orgWideDisabled = sameWeekSnapshots.reduce((s, r) => s + r.disabledCustomerOrders, 0);
  const orgWideDisabledRate = orgWideOrders > 0 ? orgWideDisabled / orgWideOrders : 0;
  const regionDisabledRate = worst.latest.orderCount > 0 ? worst.latest.disabledCustomerOrders / worst.latest.orderCount : 0;

  const fraudSignal =
    worst.latest.disabledCustomerOrders >= FRAUD_MIN_DISABLED_ORDERS &&
    orgWideDisabledRate > 0 &&
    regionDisabledRate >= orgWideDisabledRate * FRAUD_RATE_MULTIPLE;

  const baselinePct = worst.result.ewma * 100;
  const currentPct = worst.result.latestProportion * 100;

  const anomaly: AnomalyDetails = {
    zScore: Math.round(((currentPct - baselinePct) / Math.max(baselinePct, 1)) * 100) / 100,
    mean: Math.round(baselinePct * 100) / 100,
    stdDev: 0,
    actualValue: Math.round(currentPct * 100) / 100,
    date: latestWindowEnd,
    direction: 'spike',
    region: worst.region,
    currentOrders: worst.latest.orderCount,
    currentTotalOrders: worst.latest.totalOrdersInWindow,
    fraudSignal,
    regionDisabledRatePct: Math.round(regionDisabledRate * 10000) / 100,
    orgWideDisabledRatePct: Math.round(orgWideDisabledRate * 10000) / 100,
  };

  return { detected: true, anomaly };
}

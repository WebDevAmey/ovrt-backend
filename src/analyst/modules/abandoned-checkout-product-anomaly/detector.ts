import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { ProductWeekSnapshot } from './fetcher.js';
import { ewmaProportionControl } from '../stats.js';

// Per-product EWMA control chart on checkout abandonment rate.
//
// The existing CHECKOUT_ABANDONMENT_SPIKE module watches the store-wide
// abandonment rate, which can stay flat even when ONE product is suddenly
// causing carts to die (a price error, a broken variant, an OOS-but-still-
// orderable bug) if that product is a small share of total checkout volume.
// This module evaluates each product's own abandonment rate against its own
// history, sample-size gated, so a single bad SKU surfaces even when the
// store-wide rate looks normal.
const MIN_CHECKOUTS_CONTAINING = 10; // per-week sample-size floor

export function detectAbandonedCheckoutProductAnomaly(rows: FactRow[]): DetectionResult {
  const typed = rows as ProductWeekSnapshot[];
  if (typed.length === 0) return { detected: false };

  const byProduct = new Map<string, ProductWeekSnapshot[]>();
  for (const r of typed) {
    const list = byProduct.get(r.product) ?? [];
    list.push(r);
    byProduct.set(r.product, list);
  }

  let worst: { product: string; result: ReturnType<typeof ewmaProportionControl>; latest: ProductWeekSnapshot } | null = null;

  for (const [product, snapshots] of byProduct) {
    const usable = snapshots
      .filter((s) => s.checkoutsContaining >= MIN_CHECKOUTS_CONTAINING)
      .sort((a, b) => (a.windowEnd < b.windowEnd ? -1 : 1));
    if (usable.length < 4) continue;

    const result = ewmaProportionControl(
      usable.map((s) => ({
        date: s.windowEnd,
        successes: s.abandonedContaining,
        total: s.checkoutsContaining,
      })),
    );

    if (result.fired && result.direction === 'spike') {
      const deviationPp = (result.latestProportion - result.ewma) * 100;
      if (!worst || deviationPp > (worst.result.latestProportion - worst.result.ewma) * 100) {
        worst = { product, result, latest: usable[usable.length - 1]! };
      }
    }
  }

  if (!worst) return { detected: false };

  const baselinePct = worst.result.ewma * 100;
  const currentPct = worst.result.latestProportion * 100;

  const anomaly: AnomalyDetails = {
    zScore: Math.round(((currentPct - baselinePct) / Math.max(baselinePct, 1)) * 100) / 100,
    mean: Math.round(baselinePct * 100) / 100,
    stdDev: 0,
    actualValue: Math.round(currentPct * 100) / 100,
    date: worst.latest.windowEnd,
    direction: 'spike',
    product: worst.product,
    currentAbandoned: worst.latest.abandonedContaining,
    currentTotal: worst.latest.checkoutsContaining,
  };

  return { detected: true, anomaly };
}

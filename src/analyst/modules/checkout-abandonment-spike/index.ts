import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchCheckoutAbandonment,
  type CheckoutAbandonmentRow,
} from './fetcher.js';
import { detectCheckoutAbandonmentSpike } from './detector.js';

/**
 * Checkout Abandonment Spike module.
 *
 * Detects when checkout abandonment rate jumps WoW — the single biggest
 * blind spot in our existing modules, all of which look at completed orders.
 * A sudden jump usually means something is broken: payment gateway, mobile
 * regression, surprise shipping cost on the last step, etc.
 *
 * Industry baseline is ~70%; we only fire on jumps >= 8pp, not the baseline.
 */
export const checkoutAbandonmentSpikeModule: InsightModule = {
  insightType: 'CHECKOUT_ABANDONMENT_SPIKE',
  sourceType: 'shopify',
  schedule: '0 6 * * *',                  // 6am daily — want this fresh
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchCheckoutAbandonment,
  detectAnomaly: detectCheckoutAbandonmentSpike,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const snapshots = rows as CheckoutAbandonmentRow[];
    const currency = anomaly.currency as string;

    const table = snapshots
      .map(
        (r) =>
          `${r.windowEnd} | ${String(r.totalCheckouts).padStart(5)} | ${r.abandonmentRate.toFixed(1).padStart(5)}%`,
      )
      .join('\n');

    return `Store Checkout Abandonment Analysis

8 weekly snapshots of checkout abandonment rate:

week end   | started | rate
-----------|---------|------
${table}

Detected Spike (EWMA control chart):
- Latest abandonment rate: ${anomaly.actualValue.toFixed(1)}%
- Baseline (EWMA): ${anomaly.mean.toFixed(1)}%
- Jump: +${anomaly.jumpPp as number} percentage points above baseline, outside the sample-size-adjusted control limit
- ${anomaly.currentAbandoned as number} carts abandoned this week vs ${anomaly.previousAbandoned as number} last week
- Average abandoned cart value: ${currency} ${(anomaly.avgCartValue as number).toFixed(2)}
- Estimated additional lost revenue this week: ${currency} ${(anomaly.estimatedLostRevenue as number).toFixed(2)}
- This kind of jump typically points to a broken checkout step, surprise cost, or payment issue — not a demand shift.`;
  },
};

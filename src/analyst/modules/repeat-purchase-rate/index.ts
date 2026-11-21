import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchRetentionWindows, type RetentionRow } from './fetcher.js';
import { detectRepeatPurchaseRateDrop } from './detector.js';

export const repeatPurchaseRateModule: InsightModule = {
  insightType: 'REPEAT_PURCHASE_RATE_DROP',
  sourceType: 'shopify',
  schedule: '0 2 * * 1',           // 2am every Monday
  rateLimitMs: 6 * 24 * 60 * 60 * 1000, // 6 days

  resolveSource: resolveShopifySource,
  fetchData: fetchRetentionWindows,
  detectAnomaly: detectRepeatPurchaseRateDrop,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const snapshots = rows as RetentionRow[];

    const table = snapshots
      .map(
        (r) =>
          `${r.windowEnd} | ${String(r.totalCustomers).padStart(5)} | ${r.repeatPurchaseRate.toFixed(1).padStart(5)}%`,
      )
      .join('\n');

    return `Store Customer Retention Analysis

8 weekly snapshots of trailing-30-day repeat purchase rate:

window end | total | rate
-----------|-------|------
${table}

Detected Anomaly (EWMA control chart):
- Latest repeat purchase rate: ${anomaly.actualValue.toFixed(1)}%
- Baseline (EWMA): ${anomaly.mean.toFixed(1)}%
- Drop: ${anomaly.dropPp as number} percentage points below baseline, outside the sample-size-adjusted control limit (${anomaly.controlLimitLowerPct as number}%)
- This is a leading indicator — retention decay shows up here before it hits revenue`;
  },
};

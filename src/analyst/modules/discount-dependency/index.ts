import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchDiscountWindows, type DiscountRow } from './fetcher.js';
import { detectDiscountDependencyCreep } from './detector.js';

export const discountDependencyModule: InsightModule = {
  insightType: 'DISCOUNT_DEPENDENCY_CREEP',
  sourceType: 'shopify',
  schedule: '0 2 * * 5',               // 2am every Friday
  rateLimitMs: 6 * 24 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchDiscountWindows,
  detectAnomaly: detectDiscountDependencyCreep,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const snapshots = rows as DiscountRow[];

    const table = snapshots
      .map(
        (r) =>
          `${r.windowEnd} | ${String(r.totalOrders).padStart(5)} | ${r.discountUptakeRate.toFixed(1).padStart(5)}%`,
      )
      .join('\n');

    return `Store Discount Dependency Analysis

8 weekly snapshots of discount uptake rate:

week end   | orders | rate
-----------|--------|------
${table}

Detected Anomaly (EWMA control chart):
- Latest discount uptake: ${anomaly.actualValue.toFixed(1)}%
- Baseline (EWMA): ${anomaly.mean.toFixed(1)}%
- Rise: +${anomaly.deltaPp as number} percentage points above baseline, outside the sample-size-adjusted control limit
- ${anomaly.currentOrdersWithDiscount as number} out of ${anomaly.currentTotalOrders as number} orders this week used a coupon code
- Customers may be conditioning themselves to wait for discounts before buying`;
  },
};

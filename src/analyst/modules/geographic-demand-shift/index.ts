import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchRegionOrderShare,
  type RegionWeekSnapshot,
} from './fetcher.js';
import { detectGeographicDemandShift } from './detector.js';

/**
 * Geographic Demand Shift insight module.
 *
 * Watches 8 weekly snapshots of order share by shipping country via an EWMA
 * control chart. When a region's share moves beyond its own baseline, also
 * checks whether that region's share of orders from DISABLED customer
 * accounts is elevated vs. the org-wide rate the same week — distinguishing
 * a real regional demand shift (marketing, seasonality, shipping
 * disruption) from a fraud cluster.
 */
export const geographicDemandShiftModule: InsightModule = {
  insightType: 'GEOGRAPHIC_DEMAND_SHIFT',
  sourceType: 'shopify',
  schedule: '0 4 * * 2',              // 4am every Tuesday (offset from product-revenue-shift)
  rateLimitMs: 6 * 24 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchRegionOrderShare,
  detectAnomaly: detectGeographicDemandShift,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const typed = rows as RegionWeekSnapshot[];
    const region = anomaly.region as string;
    const history = typed
      .filter((r) => r.region === region)
      .sort((a, b) => (a.windowEnd < b.windowEnd ? -1 : 1));

    const table = history
      .map((r) => {
        const share = r.totalOrdersInWindow > 0 ? (r.orderCount / r.totalOrdersInWindow) * 100 : 0;
        return `${r.windowEnd} | ${String(r.orderCount).padStart(5)} | ${share.toFixed(1).padStart(5)}%`;
      })
      .join('\n');

    const fraudNote = anomaly.fraudSignal
      ? `\nFraud-cluster signal: ${anomaly.regionDisabledRatePct}% of this region's orders this week are from DISABLED customer accounts, vs ${anomaly.orgWideDisabledRatePct}% org-wide — this growth may not be organic.`
      : `\nNo elevated disabled-account rate detected for this region — this looks like organic demand movement, not a fraud cluster.`;

    return `Geographic Demand Shift — ${region}

Weekly order share history:

week end   | orders | share
-----------|--------|-------
${table}

Detected Anomaly (EWMA control chart):
- Latest order share from ${region}: ${anomaly.actualValue.toFixed(1)}%
- Baseline (EWMA): ${anomaly.mean.toFixed(1)}%
- ${anomaly.currentOrders as number} of ${anomaly.currentTotalOrders as number} orders this week shipped to ${region}${fraudNote}`;
  },
};

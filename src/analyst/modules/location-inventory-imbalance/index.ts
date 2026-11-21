import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchLocationStock,
  type ProductLocationRow,
} from './fetcher.js';
import { detectLocationImbalance } from './detector.js';

/**
 * Location Inventory Imbalance module.
 *
 * Detects when a top-selling product is configured across multiple locations
 * but at least one of them is at zero stock. Distinct from
 * INVENTORY_STOCKOUT_RISK (which fires only when a product is OOS everywhere)
 * — this one points the merchant at an inter-location transfer they can
 * make today, much faster than waiting on a supplier reorder.
 *
 * No-op for single-location merchants (filter excludes them).
 */
export const locationInventoryImbalanceModule: InsightModule = {
  insightType: 'LOCATION_INVENTORY_IMBALANCE',
  sourceType: 'shopify',
  schedule: '0 7 * * *',                  // 7am daily — operational, want it before warehouse hours
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchLocationStock,
  detectAnomaly: detectLocationImbalance,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const products = rows as ProductLocationRow[];
    const target = products.find((p) => p.product === (anomaly.product as string));

    const stockTable =
      target?.stockByLocation
        .map(
          (l) =>
            `${l.location.slice(0, 25).padEnd(25)} | ${l.available.toString().padStart(6)}`,
        )
        .join('\n') ?? '(no data)';

    const emptyLocs = (anomaly.emptyLocationNames as string[]).join(', ');

    return `Store Location Inventory Imbalance

Top sellers checked: ${products.length}
This product's stock by location:

Location                  | OnHand
--------------------------|-------
${stockTable}

Detected Imbalance — "${anomaly.product as string}":
- Daily velocity: ${(anomaly.dailyVelocity as number).toFixed(2)} units/day
- Total on-hand across all locations: ${anomaly.totalAvailable as number} units
- Configured at ${anomaly.locationsConfigured as number} locations; ${anomaly.locationsEmpty as number} of them are empty: ${emptyLocs}
- Top location "${anomaly.topLocationName as string}" holds ${anomaly.topLocationStock as number} units
- If empty locations had to be served from the remaining stock alone, you'd have ~${(anomaly.daysOfCoverIfAbsorbed as number).toFixed(1)} days of cover total
- This is an inter-location transfer opportunity — much faster than a supplier reorder.
${(anomaly.otherCandidates as number) > 0 ? `- ${anomaly.otherCandidates as number} other top-seller(s) show the same pattern` : ''}`;
  },
};

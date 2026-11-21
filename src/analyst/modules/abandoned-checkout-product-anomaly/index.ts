import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchAbandonedCheckoutProducts,
  type ProductWeekSnapshot,
} from './fetcher.js';
import { detectAbandonedCheckoutProductAnomaly } from './detector.js';

/**
 * Abandoned Checkout Product Anomaly insight module.
 *
 * Watches 6 weekly snapshots of per-product checkout abandonment rate
 * (abandoned checkouts containing the product ÷ all checkouts containing
 * it). Complements CHECKOUT_ABANDONMENT_SPIKE, which only sees the
 * store-wide rate — a single problematic SKU can drive abandonment up
 * without moving the store-wide number if it's a small share of volume.
 */
export const abandonedCheckoutProductAnomalyModule: InsightModule = {
  insightType: 'ABANDONED_CHECKOUT_PRODUCT_ANOMALY',
  sourceType: 'shopify',
  schedule: '0 11 * * *',             // 11am daily
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchAbandonedCheckoutProducts,
  detectAnomaly: detectAbandonedCheckoutProductAnomaly,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const typed = rows as ProductWeekSnapshot[];
    const product = anomaly.product as string;
    const productHistory = typed
      .filter((r) => r.product === product)
      .sort((a, b) => (a.windowEnd < b.windowEnd ? -1 : 1));

    const table = productHistory
      .map((r) => {
        const rate = r.checkoutsContaining > 0 ? (r.abandonedContaining / r.checkoutsContaining) * 100 : 0;
        return `${r.windowEnd} | ${String(r.checkoutsContaining).padStart(5)} | ${rate.toFixed(1).padStart(5)}%`;
      })
      .join('\n');

    return `Abandoned Checkout Product Anomaly

Weekly history for "${product}":

week end   | checkouts | abandon rate
-----------|-----------|-------------
${table}

Detected Anomaly (EWMA control chart, per-product):
- Latest abandonment rate for this product: ${anomaly.actualValue.toFixed(1)}%
- This product's baseline (EWMA): ${anomaly.mean.toFixed(1)}%
- ${anomaly.currentAbandoned as number} of ${anomaly.currentTotal as number} checkouts containing this product were abandoned this week

This is a per-product signal, not a store-wide one — something about this specific product (price, a broken variant, an out-of-stock-but-orderable bug) is causing carts containing it to die at an unusual rate.`;
  },
};

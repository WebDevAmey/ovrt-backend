import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchStockRisk, type StockRiskRow } from './fetcher.js';
import { detectStockoutRisk } from './detector.js';

/**
 * Inventory Stockout Risk module.
 *
 * Joins 30-day sales velocity with current on-hand inventory to find top
 * sellers that are out of stock OR will run out before typical reorder lead
 * time (14 days). Stockouts are usually the single most actionable insight
 * for a Shopify merchant — every day a bestseller is OOS is direct lost
 * revenue.
 */
export const inventoryStockoutRiskModule: InsightModule = {
  insightType: 'INVENTORY_STOCKOUT_RISK',
  sourceType: 'shopify',
  schedule: '0 4 * * *',                // 4am daily (offset from existing 2am/3am)
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchStockRisk,
  detectAnomaly: detectStockoutRisk,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const products = rows as StockRiskRow[];
    const trigger = anomaly.trigger as string;
    const currency = anomaly.currency as string;

    // Show the riskiest 5 products so the LLM can see context
    const table = products
      .slice(0, 5)
      .map((p) => {
        const cover =
          p.daysOfCover === Number.POSITIVE_INFINITY
            ? '∞'
            : `${p.daysOfCover.toFixed(1)}d`;
        return `${p.product.slice(0, 30).padEnd(30)} | ${p.unitsSold30d.toString().padStart(5)} | ${p.dailyVelocity.toFixed(2).padStart(5)} | ${p.availableNow.toString().padStart(6)} | ${cover.padStart(6)}`;
      })
      .join('\n');

    if (trigger === 'out_of_stock') {
      return `Store Inventory Stockout Risk

30-day sales velocity vs current on-hand inventory:

Product                        | Sold | /day  | OnHand | Cover
-------------------------------|------|-------|--------|-------
${table}

Critical — Out of Stock:
- Product: "${anomaly.product as string}"
- Recent velocity: ${(anomaly.dailyVelocity as number).toFixed(2)} units/day (${anomaly.unitsSold30d as number} units in last 30 days)
- Current on-hand: 0 units
- Estimated daily revenue loss: ${currency} ${(anomaly.estimatedDailyRevenueLoss as number).toFixed(2)}
- This product is selling but inventory is gone. Every day costs roughly the loss above.`;
    }

    return `Store Inventory Stockout Risk

30-day sales velocity vs current on-hand inventory:

Product                        | Sold | /day  | OnHand | Cover
-------------------------------|------|-------|--------|-------
${table}

Warning — Low Days of Cover:
- Product: "${anomaly.product as string}"
- Recent velocity: ${(anomaly.dailyVelocity as number).toFixed(2)} units/day
- Current on-hand: ${anomaly.availableNow as number} units across all variants
- Days of cover: ${(anomaly.daysOfCover as number).toFixed(1)} days (below 14-day reorder window)
${(anomaly.otherAtRiskCount as number) > 0 ? `- ${anomaly.otherAtRiskCount as number} other product(s) also below threshold` : ''}`;
  },
};

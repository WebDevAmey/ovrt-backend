import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchInventoryEfficiency, type InventoryEfficiencyRow } from './fetcher.js';
import { detectInventoryEfficiency } from './detector.js';

/**
 * Inventory Efficiency insight module.
 *
 * Merges the former SELL_THROUGH_RATE_DROP and INVENTORY_TURN_RATE_DROP
 * modules, which evaluated near-identical overstocking conditions from the
 * same sales+inventory data and fired independently on the same SKUs.
 *
 *   sell-through rate = units_sold_30d / (units_sold_30d + available_now) * 100
 *   annualized turns   = (units_sold_30d × 365/30) / available_now
 *
 * Fires WARNING when sell-through < 50% OR turns < 4/year (one signal
 * agrees the product is overstocked); CRITICAL when both agree. This
 * complements INVENTORY_STOCKOUT_RISK, which detects the opposite problem
 * (too little stock).
 */
export const inventoryEfficiencyModule: InsightModule = {
  insightType: 'INVENTORY_EFFICIENCY_DROP',
  sourceType: 'shopify',
  schedule: '0 8 * * *',              // 8am daily
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchInventoryEfficiency,
  detectAnomaly: detectInventoryEfficiency,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const products = rows as InventoryEfficiencyRow[];
    const currency = anomaly.currency as string;
    const severity = (anomaly.severity as string).toUpperCase();

    const table = products
      .slice(0, 10)
      .map((p) => {
        const turnsStr =
          p.annualizedTurns === Number.POSITIVE_INFINITY ? '  ∞' : p.annualizedTurns.toFixed(1).padStart(5);
        return `${p.product.slice(0, 30).padEnd(30)} | sold30d: ${String(p.unitsSold30d).padStart(5)} | on-hand: ${String(p.availableNow).padStart(6)} | STR: ${p.sellThroughRate.toFixed(1).padStart(5)}% | turns/yr: ${turnsStr}`;
      })
      .join('\n');

    const signals: string[] = [];
    if (anomaly.strFlagged) signals.push(`sell-through ${(anomaly.sellThroughRate as number).toFixed(1)}% (< 50%)`);
    if (anomaly.turnsFlagged && anomaly.annualizedTurns != null)
      signals.push(`${(anomaly.annualizedTurns as number).toFixed(1)} turns/year (< 4)`);

    const daysNote =
      anomaly.daysOfStock != null
        ? `At current velocity it will take ~${anomaly.daysOfStock} days to sell through the remaining stock.`
        : 'Daily velocity is too low to estimate sell-out time.';

    return `Store Inventory Efficiency Analysis (30-day window) — ${severity}

Top products by sell-through rate (worst first):

product                        | sold30d | on-hand |  STR   | turns/yr
-------------------------------|---------|---------|--------|---------
${table}

Detected Overstocking (${severity}):
- Product: "${anomaly.product as string}"
- Signals tripped: ${signals.join(', ')}
- Units sold in 30 days: ${anomaly.unitsSold30d as number}
- Units currently on hand: ${anomaly.availableNow as number}
- Daily velocity: ${(anomaly.dailyVelocity as number).toFixed(2)} units/day
- ${daysNote}
${(anomaly.otherAtRiskCount as number) > 0 ? `- ${anomaly.otherAtRiskCount as number} other product(s) also flagged` : ''}
This product is actively selling but has more inventory on hand than it can sell quickly. Capital is tied up in slow-moving stock.`;
  },
};

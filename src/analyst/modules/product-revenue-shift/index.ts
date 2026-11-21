import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchProductRevenueShift, type ProductShiftRow } from './fetcher.js';
import { detectProductRevenueShift } from './detector.js';

export const productRevenueShiftModule: InsightModule = {
  insightType: 'PRODUCT_REVENUE_SHIFT',
  sourceType: 'shopify',
  schedule: '0 2 * * 2',               // 2am every Tuesday
  rateLimitMs: 6 * 24 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchProductRevenueShift,
  detectAnomaly: detectProductRevenueShift,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const products = rows as ProductShiftRow[];
    const topMovers = (anomaly.topMovers as ProductShiftRow[]) ?? [];
    const currency = anomaly.currency as string;
    const anomalyRevPct = anomaly.revenueChangePct as number | null;
    const direction = anomalyRevPct !== null ? (anomalyRevPct > 0 ? 'rising' : 'falling') : 'rising';

    const fmtRevChange = (pct: number | null) =>
      pct === null ? '(new entrant)' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;

    const table = topMovers
      .map(
        (p) =>
          `${p.product.slice(0, 30).padEnd(30)} | ${p.previousShare.toFixed(1).padStart(6)}% → ${p.currentShare.toFixed(1).padStart(6)}% | ${fmtRevChange(p.revenueChangePct)}`,
      )
      .join('\n');

    const totalCurrRevenue = products.reduce((s, p) => s + p.currentRevenue, 0);
    const totalPrevRevenue = products.reduce((s, p) => s + p.previousRevenue, 0);

    const revLine = anomalyRevPct !== null
      ? `${currency} ${(anomaly.mean as number).toFixed(2)} → ${currency} ${(anomaly.actualValue as number).toFixed(2)} (${fmtRevChange(anomalyRevPct)})`
      : `no prior revenue (new entrant); current: ${currency} ${(anomaly.actualValue as number).toFixed(2)}`;

    return `Store Product Revenue Mix Analysis

14-day window (current vs previous):
Total revenue: ${currency} ${totalCurrRevenue.toFixed(2)} (current) vs ${currency} ${totalPrevRevenue.toFixed(2)} (previous)

Top revenue shift movers:
Product                        | Share shift          | Revenue change
-------------------------------|----------------------|---------------
${table || '(none above threshold)'}

Key Anomaly — "${anomaly.product as string}":
- Revenue share: ${(anomaly.previousShare as number).toFixed(1)}% → ${(anomaly.currentShare as number).toFixed(1)}% (${(anomaly.shareChangePp as number) > 0 ? '+' : ''}${(anomaly.shareChangePp as number).toFixed(1)} pp)
- Revenue: ${revLine}
- This product is ${direction} significantly as a share of total revenue`;
  },
};

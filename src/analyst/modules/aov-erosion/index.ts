import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchDailyAov, type AovRow } from './fetcher.js';
import { detectAovErosion } from './detector.js';

/**
 * AOV Erosion insight module.
 *
 * Watches 63 days of daily AOV (paid orders only) from Shopify. Detects
 * sustained per-basket spending decline using a day-of-week-adjusted CUSUM,
 * separate from DAILY_ORDERS_TREND which watches order *volume*.
 */
export const aovErosionModule: InsightModule = {
  insightType: 'AOV_EROSION',
  sourceType: 'shopify',
  schedule: '0 3 * * *',          // 3am daily (offset from daily-orders-trend)
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchDailyAov,
  detectAnomaly: detectAovErosion,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const recent = (rows as AovRow[]).slice(-14).filter((r) => r.orderCount > 0);
    const currency = anomaly.currency as string;

    const table = recent
      .map(
        (r) =>
          `${r.period} | ${String(r.orderCount).padStart(6)} | ${currency} ${r.averageOrderValue.toFixed(2).padStart(8)}`,
      )
      .join('\n');

    return `Store Average Order Value (AOV) Trend

Last 14 days with paid orders:

date       | orders | AOV
-----------|--------|--------
${table}

Detected Anomaly (day-of-week-adjusted CUSUM over 63 days):
- Yesterday's AOV: ${currency} ${anomaly.actualValue.toFixed(2)}
- This weekday's baseline AOV: ${currency} ${anomaly.mean.toFixed(2)}
- Decline: ${anomaly.dropPct as number}% below this weekday's baseline
- This is a sustained drop in spend-per-order, not a drop in order volume — customers are buying at a similar rate but spending less per visit`;
  },
};

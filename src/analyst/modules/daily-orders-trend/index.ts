import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchDailyOrders } from './fetcher.js';
import { detectDailyOrdersOutlier } from './detector.js';

/**
 * Daily Orders Trend insight module.
 *
 * Watches 63 days of daily order counts from Shopify (8 weeks of baseline +
 * a 7-day test window). Detects spikes/drops using a day-of-week-adjusted
 * CUSUM, which catches both single-day shocks and slow multi-day drift.
 * Surfaces anomalies as conversational hooks if magnitude is significant.
 */
export const dailyOrdersTrendModule: InsightModule = {
  insightType: 'DAILY_ORDERS_TREND',
  sourceType: 'shopify',
  schedule: '0 2 * * *',
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchDailyOrders,
  detectAnomaly: detectDailyOrdersOutlier,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    // Show only the most recent 14 days in the table for prompt brevity,
    // even though detection uses the full 63-day series.
    const recent = (rows as any[]).slice(-14);
    const table = recent
      .map(
        (row: any) =>
          `${row.period} | ${String(row.orderCount).padStart(6)} | ${(row.sales ?? 0).toFixed(2).padStart(8)}`,
      )
      .join('\n');

    const deviation = Math.round(
      (((anomaly.actualValue - anomaly.mean) / Math.max(anomaly.mean, 1)) * 100)
    );

    return `Store Daily Orders Trend

Last 14 days of daily order history (most recent is yesterday):

date       | orders | sales
-----------|--------|--------
${table}

Detected Anomaly (day-of-week-adjusted CUSUM over 63 days):
- Yesterday (${anomaly.date}): ${anomaly.actualValue} orders
- This weekday's baseline average: ${anomaly.mean} orders/day
- This weekday's standard deviation: ${anomaly.stdDev}
- Cumulative deviation (CUSUM): ${anomaly.zScore}
- Direction: ${deviation > 0 ? 'UP' : 'DOWN'} ${Math.abs(deviation)}% from this weekday's average
- Pattern: This is a sustained ${anomaly.direction === 'spike' ? 'spike' : 'decline'}, accounting for normal day-of-week patterns.`;
  },
};

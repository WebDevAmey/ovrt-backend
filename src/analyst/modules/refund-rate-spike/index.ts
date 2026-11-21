import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveShopifySource, fetchRefundWindows, type RefundSummaryRow, type RefundProductRow } from './fetcher.js';
import { detectRefundRateSpike } from './detector.js';

export const refundRateSpikeModule: InsightModule = {
  insightType: 'REFUND_RATE_SPIKE',
  sourceType: 'shopify',
  schedule: '0 2 * * 3',               // 2am every Wednesday
  rateLimitMs: 6 * 24 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchRefundWindows,
  detectAnomaly: detectRefundRateSpike,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const summaries = rows.filter(
      (r) => (r as { rowType?: string }).rowType === 'summary',
    ) as RefundSummaryRow[];
    const curr = summaries[summaries.length - 1]!;
    const trigger = anomaly.trigger as string;

    const table = summaries
      .map(
        (r) =>
          `${r.windowEnd} | ${String(r.totalOrders).padStart(5)} | ${r.refundRate.toFixed(1).padStart(5)}%`,
      )
      .join('\n');

    if (trigger === 'product_surge') {
      return `Store Refund Analysis — Product-Level Surge

window end | orders | refund rate
-----------|--------|------------
${table}

Product Refund Surge:
- Product: "${anomaly.product as string}"
- Refund occurrences this period: ${anomaly.actualValue}
- Previous period: ${anomaly.mean}
- Units refunded this period: ${anomaly.unitsRefunded as number}
- Overall refund rate: ${(anomaly.overallRefundRate as number).toFixed(1)}%

This product's return rate has surged beyond what its own baseline would predict, before customer reviews reflect it.`;
    }

    return `Store Refund Rate Analysis

8 weekly snapshots (14-day windows):

window end | orders | refund rate
-----------|--------|------------
${table}

Detected Anomaly (EWMA control chart):
- Latest refund rate: ${anomaly.actualValue.toFixed(1)}%
- Baseline (EWMA): ${anomaly.mean.toFixed(1)}%
- Rise: +${anomaly.deltaPp as number} percentage points above baseline, outside the sample-size-adjusted control limit`;
  },
};

import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchFulfillmentDelays,
  type FulfillmentSummaryRow,
  type FulfillmentAgedOrderRow,
} from './fetcher.js';
import { detectFulfillmentDelay } from './detector.js';

/**
 * Fulfillment Delay Spike module.
 *
 * Snapshot-based (not trend-based): looks at currently-unfulfilled orders and
 * fires when aged orders (>=3 days unfulfilled) are either an SLA breach
 * (>=14 days for a single order) or a systemic backlog (>=5 orders AND >=10%
 * of last 7-day order volume).
 */
export const fulfillmentDelayModule: InsightModule = {
  insightType: 'FULFILLMENT_DELAY_SPIKE',
  sourceType: 'shopify',
  schedule: '0 5 * * *',                // 5am daily — operational signal, want it early
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchFulfillmentDelays,
  detectAnomaly: detectFulfillmentDelay,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const summary = rows.find(
      (r) => (r as { rowType?: string }).rowType === 'summary',
    ) as FulfillmentSummaryRow;
    const orders = rows.filter(
      (r) => (r as { rowType?: string }).rowType === 'order',
    ) as FulfillmentAgedOrderRow[];

    const orderLines = orders
      .map((o) => {
        const loc = [o.shippingCity, o.shippingCountry].filter(Boolean).join(', ') || '—';
        return `${o.orderNumber.padEnd(8)} | ${o.daysUnfulfilled.toString().padStart(4)}d | ${o.items.slice(0, 40)} | ${loc}`;
      })
      .join('\n');

    const trigger = anomaly.trigger as string;
    const body =
      trigger === 'critical_aged_order'
        ? `Critical — Order Past SLA:
- Oldest unfulfilled order is ${summary.maxAgedDays} days old (well past any reasonable SLA)
- ${summary.agedCount} order(s) currently aged ≥ 3 days
- Median age across aged orders: ${summary.medianAgedDays} days`
        : `Warning — Backlog Building:
- ${summary.agedCount} order(s) aged ≥ 3 days unfulfilled
- That's ${(summary.agedRatio * 100).toFixed(1)}% of the last 7 days' order volume (${summary.totalRecentOrders} orders)
- Median age across aged orders: ${summary.medianAgedDays} days
- Oldest: ${summary.maxAgedDays} days
${anomaly.isSingleDayBlip ? `- Note: ${(summary.modalDayRatio * 100).toFixed(0)}% of the backlog shares the same age, suggesting one bad calendar day rather than a sustained, multi-day trend` : '- Backlog is spread across multiple days, suggesting a sustained delay rather than a one-off blip'}`;

    return `Store Fulfillment Delay Snapshot

Currently unfulfilled (last 30 days): ${summary.totalUnfulfilledAny}
Aged unfulfilled (≥ 3 days):          ${summary.agedCount}
Recent order volume (last 7 days):    ${summary.totalRecentOrders}

Worst aged orders:
Order#   | Age  | Items                                    | Location
---------|------|------------------------------------------|----------
${orderLines || '(none)'}

${body}`;
  },
};

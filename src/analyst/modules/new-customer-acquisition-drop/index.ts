import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchNewCustomerAcquisition,
  type NewCustomerRow,
} from './fetcher.js';
import { detectNewCustomerAcquisitionDrop } from './detector.js';

/**
 * New Customer Acquisition Drop module.
 *
 * Top-of-funnel signal — independent from every existing module, which all
 * look at completed orders. A drop in new-customer acquisition typically
 * precedes a revenue decline by weeks (because retention masks the gap
 * temporarily), so this is a leading indicator.
 *
 * Compares 30-day windows; fires only when previous window had >= 30 new
 * customers AND current dropped by >= 30% AND >= 10 customers absolutely.
 */
export const newCustomerAcquisitionDropModule: InsightModule = {
  insightType: 'NEW_CUSTOMER_ACQUISITION_DROP',
  sourceType: 'shopify',
  schedule: '0 3 * * 4',                  // 3am every Thursday
  rateLimitMs: 6 * 24 * 60 * 60 * 1000,   // 6 days

  resolveSource: resolveShopifySource,
  fetchData: fetchNewCustomerAcquisition,
  detectAnomaly: detectNewCustomerAcquisitionDrop,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const curr = rows[0] as NewCustomerRow;
    const prev = rows[1] as NewCustomerRow;

    return `Store New Customer Acquisition Analysis

30-day window comparison:

Metric                         | Current (${curr.windowStart} → ${curr.windowEnd}) | Previous (${prev.windowStart} → ${prev.windowEnd})
-------------------------------|-----------------------------------|-----------------------------------
New Signups                    | ${curr.totalCustomers}                         | ${prev.totalCustomers}
New Customers (signup + buy)   | ${curr.newCustomers}                          | ${prev.newCustomers}
Signup → First Purchase Rate   | ${curr.conversionRate.toFixed(1)}%                       | ${prev.conversionRate.toFixed(1)}%

Detected Drop:
- New customer acquisitions fell from ${prev.newCustomers} to ${curr.newCustomers} (-${anomaly.absoluteDrop as number}, -${(anomaly.dropPct as number).toFixed(1)}%)
- Signup → purchase conversion: ${prev.conversionRate.toFixed(1)}% → ${curr.conversionRate.toFixed(1)}%
- This is a top-of-funnel signal — common drivers include paused ad campaigns, SEO ranking changes, or a competitor running heavier promos.
- Note: retention masks this in revenue numbers for a few weeks; this metric catches it earlier.`;
  },
};

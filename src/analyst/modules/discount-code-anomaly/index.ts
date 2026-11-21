import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchDiscountCodeDailySeries,
  type DiscountCodeDailyRow,
} from './fetcher.js';
import { detectDiscountCodeAnomaly } from './detector.js';

/**
 * Discount Code Anomaly insight module.
 *
 * Watches per-code discount performance (redemption count and
 * average-discount-per-order), invisible to DISCOUNT_DEPENDENCY_CREEP which
 * only sees the store-wide uptake rate. Catches margin leaks at the
 * individual-code level: a leaked/abused code redeeming far more than its
 * own history, or a misconfigured code burning more margin per order than
 * every other active code.
 */
export const discountCodeAnomalyModule: InsightModule = {
  insightType: 'DISCOUNT_CODE_ANOMALY',
  sourceType: 'shopify',
  schedule: '0 2 * * 6',              // 2am every Saturday
  rateLimitMs: 6 * 24 * 60 * 60 * 1000,

  resolveSource: resolveShopifySource,
  fetchData: fetchDiscountCodeDailySeries,
  detectAnomaly: detectDiscountCodeAnomaly,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const typed = rows as DiscountCodeDailyRow[];
    const code = anomaly.code as string;
    const trigger = anomaly.trigger as string;
    const currency = anomaly.currency as string;

    if (trigger === 'redemption_surge') {
      const codeRows = typed.filter((r) => r.code === code).sort((a, b) => (a.date < b.date ? -1 : 1));
      const table = codeRows
        .slice(-14)
        .map((r) => `${r.date} | ${String(r.uses).padStart(5)}`)
        .join('\n');

      return `Discount Code Anomaly — Redemption Surge

Last 14 days of redemptions for code "${code}":

date       | uses
-----------|------
${table}

Detected Surge (day-of-week-adjusted CUSUM):
- Yesterday's redemptions: ${anomaly.actualValue}
- This weekday's baseline: ${anomaly.mean}
- Cumulative deviation (CUSUM): ${anomaly.zScore}

This code is being redeemed far more than its own history predicts — check for a leaked code, unexpected influencer/affiliate traffic, or abuse.`;
    }

    return `Discount Code Anomaly — Margin Outlier

Code "${code}" average discount per order: ${currency} ${(anomaly.actualValue as number).toFixed(2)}
Average across ${anomaly.codesCompared as number} other active codes: ${currency} ${(anomaly.mean as number).toFixed(2)}
Z-score vs other codes: ${anomaly.zScore}
Total uses in window: ${anomaly.totalUses as number}

This code is burning significantly more margin per order than every other active discount code — check for a misconfigured value or a stacking bug.`;
  },
};

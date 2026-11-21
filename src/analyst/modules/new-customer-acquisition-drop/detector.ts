import type { DetectionResult, FactRow } from '../types.js';
import type { NewCustomerRow } from './fetcher.js';

// Fires when new-customer acquisition drops materially WoW. This is a
// top-of-funnel signal that the existing modules (which all look at completed
// orders) don't capture. Common drivers: ad spend cut, paused campaign,
// SEO drop, a competitor running aggressive promos.
//
// Gates:
//   - Previous window must have at least MIN_PREV_NEW customers (statistical floor)
//   - Drop must be at least DROP_RATIO (e.g., 30% drop → current < 70% of previous)
//   - Use an absolute floor of MIN_ABSOLUTE_DROP — going from 25 to 17 (32% drop)
//     is noisier than going from 100 to 70 (also 30%). Require at least 10
//     fewer customers in absolute terms.
const MIN_PREV_NEW = 30;
const DROP_RATIO = 0.70;            // current must be below 70% of previous
const MIN_ABSOLUTE_DROP = 10;

export function detectNewCustomerAcquisitionDrop(rows: FactRow[]): DetectionResult {
  if (rows.length < 2) return { detected: false };

  const curr = rows[0] as NewCustomerRow;
  const prev = rows[1] as NewCustomerRow;

  if (prev.newCustomers < MIN_PREV_NEW) return { detected: false };
  if (curr.newCustomers >= prev.newCustomers * DROP_RATIO) return { detected: false };
  if (prev.newCustomers - curr.newCustomers < MIN_ABSOLUTE_DROP) return { detected: false };

  const dropPct = ((prev.newCustomers - curr.newCustomers) / prev.newCustomers) * 100;

  return {
    detected: true,
    anomaly: {
      zScore: Math.round(dropPct * 100) / 100,
      mean: prev.newCustomers,
      stdDev: 0,
      actualValue: curr.newCustomers,
      date: curr.windowEnd,
      direction: 'drop',
      dropPct: Math.round(dropPct * 100) / 100,
      absoluteDrop: prev.newCustomers - curr.newCustomers,
      currentPeriod: `${curr.windowStart} → ${curr.windowEnd}`,
      previousPeriod: `${prev.windowStart} → ${prev.windowEnd}`,
      currentConversionRate: curr.conversionRate,
      previousConversionRate: prev.conversionRate,
      currentSignups: curr.totalCustomers,
      previousSignups: prev.totalCustomers,
      currency: curr.currency,
    },
  };
}

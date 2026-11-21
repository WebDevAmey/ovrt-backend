import type { DetectionResult, FactRow } from '../types.js';
import type { FulfillmentSummaryRow } from './fetcher.js';

// Two fires:
//   1. CRITICAL — any single order has been unfulfilled >= 14 days. That's
//      well past any reasonable SLA and is a guaranteed customer-service issue.
//   2. WARNING — aged unfulfilled (>=3 days) is BOTH absolutely large
//      (>=5 orders) AND a meaningful share of recent flow (>=10% of last 7 days).
//
// The double-condition warning avoids false positives in both directions:
//   - small stores with 2 aged orders out of 15 (13% ratio) wouldn't fire
//     because absolute count is 2 — usually a manual followup is enough
//   - large stores with 30 aged orders out of 5000 (0.6% ratio) wouldn't fire
//     because, while 30 sounds big, it's not a systemic delay signal
//
// A backlog where most aged orders share the same daysUnfulfilled value (one
// bad calendar day, e.g. a missed courier pickup) is a smaller, usually
// self-resolving signal compared to one spread across several days — raise
// the bar for that case so a single-day blip needs a bigger count to fire.
const CRITICAL_AGE_DAYS = 14;
const WARNING_MIN_COUNT = 5;
const WARNING_MIN_RATIO = 0.10;
const SINGLE_DAY_DOMINANCE_RATIO = 0.6;
const SINGLE_DAY_MIN_COUNT = 8;

export function detectFulfillmentDelay(rows: FactRow[]): DetectionResult {
  const summary = rows.find(
    (r) => (r as { rowType?: string }).rowType === 'summary',
  ) as FulfillmentSummaryRow | undefined;

  if (!summary) return { detected: false };

  // Critical: any order well past SLA
  if (summary.maxAgedDays >= CRITICAL_AGE_DAYS) {
    return {
      detected: true,
      anomaly: {
        zScore: 0,
        mean: summary.medianAgedDays,
        stdDev: 0,
        actualValue: summary.maxAgedDays,
        date: summary.windowEnd,
        direction: 'spike',
        trigger: 'critical_aged_order',
        agedCount: summary.agedCount,
        medianAgedDays: summary.medianAgedDays,
        maxAgedDays: summary.maxAgedDays,
        totalRecentOrders: summary.totalRecentOrders,
        agedRatio: Math.round(summary.agedRatio * 1000) / 1000,
      },
    };
  }

  // Warning: systemic aged backlog. If the backlog is dominated by a single
  // calendar day, require a larger count before treating it as systemic.
  const isSingleDayBlip = summary.modalDayRatio >= SINGLE_DAY_DOMINANCE_RATIO;
  const countThreshold = isSingleDayBlip ? SINGLE_DAY_MIN_COUNT : WARNING_MIN_COUNT;

  if (
    summary.agedCount >= countThreshold &&
    summary.agedRatio >= WARNING_MIN_RATIO
  ) {
    return {
      detected: true,
      anomaly: {
        zScore: 0,
        mean: 0,
        stdDev: 0,
        actualValue: summary.agedCount,
        date: summary.windowEnd,
        direction: 'spike',
        trigger: 'backlog',
        agedCount: summary.agedCount,
        medianAgedDays: summary.medianAgedDays,
        maxAgedDays: summary.maxAgedDays,
        totalRecentOrders: summary.totalRecentOrders,
        agedRatio: Math.round(summary.agedRatio * 1000) / 1000,
        isSingleDayBlip,
        modalDayRatio: summary.modalDayRatio,
      },
    };
  }

  return { detected: false };
}

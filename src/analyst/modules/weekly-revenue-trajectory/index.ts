import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import {
  resolveShopifySource,
  fetchWeeklyRevenue,
  type WeeklyRevenueRow,
} from './fetcher.js';
import { detectWeeklyRevenueTrajectory } from './detector.js';

/**
 * Weekly Revenue Trajectory module.
 *
 * Runs linear regression on 12 complete ISO weeks of revenue. Fires when the
 * relative slope is large (>2%/week) AND the fit is consistent (R² >= 0.4).
 *
 * This catches what daily z-score can't: a smooth slow decline (or growth)
 * that never shows up in day-over-day comparisons but compounds to ~25%+
 * change over a quarter.
 */
export const weeklyRevenueTrajectoryModule: InsightModule = {
  insightType: 'WEEKLY_REVENUE_TRAJECTORY',
  sourceType: 'shopify',
  schedule: '0 4 * * 1',                  // 4am every Monday (after the previous week closes)
  rateLimitMs: 6 * 24 * 60 * 60 * 1000,   // 6 days

  resolveSource: resolveShopifySource,
  fetchData: fetchWeeklyRevenue,
  detectAnomaly: detectWeeklyRevenueTrajectory,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const weeks = rows as WeeklyRevenueRow[];
    const currency = anomaly.currency as string;
    const direction = anomaly.direction;

    const table = weeks
      .map(
        (w) =>
          `${w.weekStart} → ${w.weekEnd} | ${w.orderCount.toString().padStart(5)} | ${currency} ${w.revenue.toFixed(2).padStart(10)}`,
      )
      .join('\n');

    const dirWord = direction === 'spike' ? 'growth' : 'decline';
    const slopeSign = (anomaly.slopePerWeek as number) >= 0 ? '+' : '';
    const totalSign = (anomaly.totalImpliedChangePct as number) >= 0 ? '+' : '';

    return `Store Weekly Revenue Trajectory

12 complete ISO weeks (Mon → Sun):

week range            | orders | revenue
----------------------|--------|----------
${table}

Detected Trend — Sustained ${dirWord}:
- Mean weekly revenue: ${currency} ${(anomaly.meanWeeklyRevenue as number).toFixed(2)}
- Slope: ${slopeSign}${currency} ${(anomaly.slopePerWeek as number).toFixed(2)} per week (${slopeSign}${(anomaly.relativeSlopePct as number).toFixed(2)}% of mean per week)
- Implied total change over 12 weeks: ${totalSign}${(anomaly.totalImpliedChangePct as number).toFixed(1)}%
- R² (trend consistency): ${(anomaly.rSquared as number).toFixed(3)} — ${(anomaly.rSquared as number) > 0.7 ? 'very consistent' : 'moderately consistent'} fit
- This is a slow, sustained ${dirWord} that day-over-day comparisons cannot see.`;
  },
};

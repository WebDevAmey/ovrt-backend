import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { DiscountCodeDailyRow } from './fetcher.js';
import { seasonalCusum } from '../stats.js';
import { daysAgoStr } from '../shopify-shared.js';
import { ANALYST_ZSCORE_THRESHOLD } from '../../constants.js';

// Two independent triggers on per-discount-code performance, invisible to
// the store-wide DISCOUNT_DEPENDENCY_CREEP module which only watches
// overall uptake:
//
// 1. REDEMPTION SURGE — day-of-week-adjusted CUSUM on a code's own daily
//    redemption count. Catches a code being used far more than its own
//    history would predict (leaked online, abused, or an influencer driving
//    unexpected volume).
// 2. MARGIN OUTLIER — a code's average-discount-per-order is a z-score
//    outlier against the distribution of all OTHER active codes' averages.
//    Catches a misconfigured or stacking code burning more margin per order
//    than every other code in use.
const DAILY_LOOKBACK_DAYS = 63;
const MIN_TOTAL_USES = 5; // per code, across the full window
const MIN_CODES_FOR_MARGIN_TEST = 5; // need a real distribution to compare against

export function detectDiscountCodeAnomaly(rows: FactRow[]): DetectionResult {
  const typed = rows as DiscountCodeDailyRow[];
  if (typed.length === 0) return { detected: false };

  const byCode = new Map<string, DiscountCodeDailyRow[]>();
  for (const r of typed) {
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }

  // Trigger 1: redemption surge
  let bestBurst: { code: string; result: ReturnType<typeof seasonalCusum> } | null = null;
  for (const [code, dailyRows] of byCode) {
    const totalUses = dailyRows.reduce((s, r) => s + r.uses, 0);
    if (totalUses < MIN_TOTAL_USES) continue;

    const byDate = new Map(dailyRows.map((r) => [r.date, r.uses]));
    const series = [];
    for (let i = DAILY_LOOKBACK_DAYS; i >= 1; i--) {
      const date = daysAgoStr(i);
      series.push({ date, value: byDate.get(date) ?? 0 });
    }

    const result = seasonalCusum(series);
    if (result.fired && result.direction === 'spike') {
      if (!bestBurst || result.cusumValue > bestBurst.result.cusumValue) {
        bestBurst = { code, result };
      }
    }
  }

  if (bestBurst) {
    const { code, result } = bestBurst;
    const anomaly: AnomalyDetails = {
      zScore: result.cusumValue,
      mean: result.weekdayMean,
      stdDev: result.weekdayStdDev,
      actualValue: result.latestValue,
      date: daysAgoStr(1),
      direction: 'spike',
      trigger: 'redemption_surge',
      code,
    };
    return { detected: true, anomaly };
  }

  // Trigger 2: margin outlier vs the org's other active codes
  const codeAverages = Array.from(byCode.entries())
    .map(([code, dailyRows]) => {
      const totalUses = dailyRows.reduce((s, r) => s + r.uses, 0);
      const totalDiscount = dailyRows.reduce((s, r) => s + r.totalDiscount, 0);
      const currency = dailyRows[0]?.currency ?? '';
      return {
        code,
        totalUses,
        avgDiscountPerOrder: totalUses > 0 ? totalDiscount / totalUses : 0,
        currency,
      };
    })
    .filter((c) => c.totalUses >= MIN_TOTAL_USES);

  if (codeAverages.length < MIN_CODES_FOR_MARGIN_TEST) return { detected: false };

  const values = codeAverages.map((c) => c.avgDiscountPerOrder);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return { detected: false };

  let outlier: (typeof codeAverages)[number] | null = null;
  let outlierZ = 0;
  for (const c of codeAverages) {
    const z = (c.avgDiscountPerOrder - mean) / stdDev;
    if (z > ANALYST_ZSCORE_THRESHOLD && z > outlierZ) {
      outlier = c;
      outlierZ = z;
    }
  }

  if (!outlier) return { detected: false };

  const anomaly: AnomalyDetails = {
    zScore: Math.round(outlierZ * 100) / 100,
    mean: Math.round(mean * 100) / 100,
    stdDev: Math.round(stdDev * 100) / 100,
    actualValue: Math.round(outlier.avgDiscountPerOrder * 100) / 100,
    date: daysAgoStr(1),
    direction: 'spike',
    trigger: 'margin_outlier',
    code: outlier.code,
    totalUses: outlier.totalUses,
    currency: outlier.currency,
    codesCompared: codeAverages.length,
  };

  return { detected: true, anomaly };
}

import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { InsightRow } from './fetcher.js';
import { seasonalCusum, ewmaProportionControl } from '../stats.js';
import { daysAgoStr } from '../shopify-shared.js';

// Two independent triggers, both built from the same CustomerInsight rows
// (Gmail + WhatsApp support adapters):
//
// 1. COMPLAINT BURST — day-of-week-adjusted CUSUM on the daily count of a
//    specific complaint type (PRODUCT_QUALITY, WRONG_OR_DAMAGED_ITEM, etc.).
//    A burst in one type fires even if overall sentiment looks stable — this
//    is often a leading indicator of a bad batch or packaging issue that
//    shows up in REFUND_RATE_SPIKE weeks later.
// 2. SENTIMENT RATIO — EWMA control chart on negative-sentiment share of all
//    insights across 8 weekly snapshots.
const DAILY_LOOKBACK_DAYS = 63;
const WEEKLY_SNAPSHOT_COUNT = 8;
const WEEKLY_WINDOW_DAYS = 7;
const MIN_DAILY_TOTAL_FOR_TYPE_BURST = 3; // ignore types with near-zero volume entirely

function zeroFilledDailySeries(
  rows: InsightRow[],
  predicate: (r: InsightRow) => boolean,
  lookbackDays: number,
): { date: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!predicate(r)) continue;
    counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  }
  const series: { date: string; value: number }[] = [];
  for (let i = lookbackDays; i >= 1; i--) {
    const date = daysAgoStr(i);
    series.push({ date, value: counts.get(date) ?? 0 });
  }
  return series;
}

export function detectSupportSentimentSpike(rows: FactRow[]): DetectionResult {
  const typed = rows as InsightRow[];
  if (typed.length === 0) return { detected: false };

  // Trigger 1: per-complaint-type burst
  const types = Array.from(new Set(typed.map((r) => r.type)));
  let bestBurst: { type: string; result: ReturnType<typeof seasonalCusum> } | null = null;

  for (const type of types) {
    const series = zeroFilledDailySeries(typed, (r) => r.type === type, DAILY_LOOKBACK_DAYS);
    const totalVolume = series.reduce((s, p) => s + p.value, 0);
    if (totalVolume < MIN_DAILY_TOTAL_FOR_TYPE_BURST) continue;

    const result = seasonalCusum(series);
    if (result.fired && result.direction === 'spike') {
      if (!bestBurst || result.cusumValue > bestBurst.result.cusumValue) {
        bestBurst = { type, result };
      }
    }
  }

  if (bestBurst) {
    const { type, result } = bestBurst;
    const anomaly: AnomalyDetails = {
      zScore: result.cusumValue,
      mean: result.weekdayMean,
      stdDev: result.weekdayStdDev,
      actualValue: result.latestValue,
      date: daysAgoStr(1),
      direction: 'spike',
      trigger: 'complaint_burst',
      complaintType: type,
    };
    return { detected: true, anomaly };
  }

  // Trigger 2: overall negative-sentiment share
  const offsets = Array.from({ length: WEEKLY_SNAPSHOT_COUNT }, (_, i) => i * WEEKLY_WINDOW_DAYS);
  const weeklySnapshots = offsets
    .map((offset) => {
      const windowEnd = daysAgoStr(1 + offset);
      const windowStart = daysAgoStr(WEEKLY_WINDOW_DAYS + offset);
      const inWindow = typed.filter((r) => r.date >= windowStart && r.date <= windowEnd);
      const negative = inWindow.filter((r) => r.sentiment === 'NEGATIVE').length;
      return { date: windowEnd, successes: negative, total: inWindow.length };
    })
    .reverse(); // ascending chronological order

  const usable = weeklySnapshots.filter((s) => s.total > 0);
  if (usable.length < 4) return { detected: false };

  const result = ewmaProportionControl(usable);
  if (!result.fired || result.direction !== 'spike') return { detected: false };

  const baselinePct = result.ewma * 100;
  const currentPct = result.latestProportion * 100;
  const latest = usable[usable.length - 1]!;

  const anomaly: AnomalyDetails = {
    zScore: Math.round(((currentPct - baselinePct) / Math.max(baselinePct, 1)) * 100) / 100,
    mean: Math.round(baselinePct * 100) / 100,
    stdDev: 0,
    actualValue: Math.round(currentPct * 100) / 100,
    date: latest.date,
    direction: 'spike',
    trigger: 'sentiment_ratio',
    currentNegative: latest.successes,
    currentTotal: latest.total,
  };

  return { detected: true, anomaly };
}

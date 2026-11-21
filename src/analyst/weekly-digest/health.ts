import { pctChange } from './utils.js';
import type { DigestStoreMetrics, DigestAnomalySummary } from './types.js';

/**
 * Deterministic store-health score (0–100).
 *
 * The score is computed from the actual metrics — NOT invented by the LLM — so
 * that it is stable across runs and comparable week-over-week. The headline
 * badge in the email keys off this number, so the merchant must be able to
 * trust it and watch it trend.
 *
 * Starts from a neutral 70 ("healthy") and adjusts within [0, 100]:
 *   • Revenue WoW        — the dominant signal (±18)
 *   • Orders WoW         — secondary volume signal (±8)
 *   • Refund rate        — quality/satisfaction drag (0 → −14)
 *   • Checkout abandon.  — funnel drag above the ~70% industry baseline (0 → −8)
 *   • Anomalies          — severity-weighted penalty (0 → −12)
 *   • Inventory          — out-of-stock items cap upside (0 → −8)
 *
 * A null WoW (zero prior-week baseline) contributes nothing rather than being
 * treated as a flat week.
 */
export function computeHealthScore(
  m: DigestStoreMetrics,
  anomalies: DigestAnomalySummary[],
): number {
  let score = 70;

  // Revenue trend — strongest driver. Clamp the contribution so a single wild
  // week can't peg the score; ±30% maps to roughly ±18 points.
  const revWow = pctChange(m.totalRevenue, m.priorWeekRevenue);
  if (revWow !== null) {
    score += clamp((revWow / 30) * 18, -18, 18);
  }

  // Order-volume trend — confirms or tempers the revenue move.
  const ordWow = pctChange(m.totalOrders, m.priorWeekOrders);
  if (ordWow !== null) {
    score += clamp((ordWow / 30) * 8, -8, 8);
  }

  // Refund rate — every point of refund rate is a satisfaction/quality signal.
  // 0% → 0 penalty, 10%+ → full −14.
  score -= clamp((m.refundRate / 10) * 14, 0, 14);

  // Checkout abandonment — only penalise above the ~70% industry baseline.
  if (m.abandonmentRate > 70) {
    score -= clamp(((m.abandonmentRate - 70) / 20) * 8, 0, 8);
  }

  // Anomalies — severity-weighted. high=4, medium=2, low=1, capped at −12.
  const anomalyWeight = anomalies.reduce((sum, a) => {
    if (a.severity === 'high') return sum + 4;
    if (a.severity === 'medium') return sum + 2;
    return sum + 1;
  }, 0);
  score -= Math.min(anomalyWeight * 2, 12);

  // Inventory — out-of-stock sellers cap growth. Scale to catalogue exposure.
  if (m.outOfStockCount > 0) {
    score -= Math.min(m.outOfStockCount, 8);
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

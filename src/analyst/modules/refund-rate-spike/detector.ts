import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { RefundSummaryRow, RefundProductRow } from './fetcher.js';
import { ewmaProportionControl } from '../stats.js';

// Two triggers:
// 1. Overall refund rate breaches an EWMA control chart built from 8 weekly
//    snapshots (replaces the old flat ">2pp WoW" heuristic, which couldn't
//    tell a real shift from noise at low order volume).
// 2. A specific product's refund count breaches a Poisson-style control
//    limit (mean + 3*sqrt(mean)) against its own prior-period baseline —
//    replaces the old raw "tripled" heuristic, which treated 1→3 (noise)
//    the same as 100→300 (real signal). Requires prevCount >= 5 before the
//    statistical test applies; a separate, stricter floor catches brand-new
//    hotspots with no prior baseline.
export function detectRefundRateSpike(rows: FactRow[]): DetectionResult {
  const summaries = (rows.filter(
    (r) => (r as { rowType?: string }).rowType === 'summary',
  ) as RefundSummaryRow[]).filter((r) => r.totalOrders >= 20);

  const products = rows.filter(
    (r) => (r as { rowType?: string }).rowType === 'product',
  ) as RefundProductRow[];
  const currProducts = products.filter((r) => r.period === 'current');
  const prevProducts = products.filter((r) => r.period === 'previous');

  // Trigger 1: overall rate spike via EWMA control chart
  if (summaries.length >= 4) {
    const result = ewmaProportionControl(
      summaries.map((r) => ({
        date: r.windowEnd,
        successes: r.ordersWithRefunds,
        total: r.totalOrders,
      })),
    );

    if (result.fired && result.direction === 'spike') {
      const curr = summaries[summaries.length - 1]!;
      const baselinePct = result.ewma * 100;
      const currentPct = result.latestProportion * 100;
      return {
        detected: true,
        anomaly: {
          zScore: Math.round(((currentPct - baselinePct) / Math.max(baselinePct, 1)) * 100) / 100,
          mean: Math.round(baselinePct * 100) / 100,
          stdDev: 0,
          actualValue: Math.round(currentPct * 100) / 100,
          date: curr.windowEnd,
          direction: 'spike',
          trigger: 'rate_spike',
          deltaPp: Math.round((currentPct - baselinePct) * 100) / 100,
          currentWindow: `${curr.windowStart} → ${curr.windowEnd}`,
          currentOrderCount: curr.totalOrders,
          currency: curr.currency,
        },
      };
    }
  }

  // Trigger 2: product-level refund surge
  const prevMap = new Map(prevProducts.map((p) => [p.product, p.refundOccurrences]));
  const latestSummary = summaries[summaries.length - 1];
  for (const cp of currProducts) {
    const prevCount = prevMap.get(cp.product) ?? 0;

    const newHotspot = prevCount === 0 && cp.refundOccurrences >= 5;
    const poissonLimit = prevCount + 3 * Math.sqrt(prevCount);
    const significantRise = prevCount >= 5 && cp.refundOccurrences > poissonLimit;

    if (newHotspot || significantRise) {
      return {
        detected: true,
        anomaly: {
          zScore: prevCount > 0 ? Math.round((cp.refundOccurrences / prevCount) * 100) / 100 : 0,
          mean: prevCount,
          stdDev: 0,
          actualValue: cp.refundOccurrences,
          date: latestSummary?.windowEnd ?? '',
          direction: 'spike',
          trigger: 'product_surge',
          product: cp.product,
          unitsRefunded: cp.unitsRefunded,
          previousRefunds: prevCount,
          overallRefundRate: latestSummary?.refundRate ?? 0,
          currency: latestSummary?.currency ?? '',
        },
      };
    }
  }

  return { detected: false };
}

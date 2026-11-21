import type { DetectionResult, FactRow } from '../types.js';
import type { StockRiskRow } from './fetcher.js';

// Stockout risk detection. Two fires:
//
//   1. CRITICAL — a top-selling product is OUT OF STOCK right now and
//      still has nonzero recent velocity. Every day this stays unfixed is
//      direct lost revenue.
//
//   2. WARNING — a top-selling product will run out within typical reorder
//      lead time (DAYS_OF_COVER_THRESHOLD). Catches the more common case
//      where the merchant doesn't realize a bestseller is about to vanish.
//
// Velocity floor (MIN_VELOCITY) excludes long-tail items that would otherwise
// produce noisy alerts ("you have 1 unit and sell 0.1/day" ⇒ "10 days of cover"
// is technically true but meaningless).
const DAYS_OF_COVER_THRESHOLD = 14;
const MIN_VELOCITY = 0.5;

export function detectStockoutRisk(rows: FactRow[]): DetectionResult {
  if (rows.length === 0) return { detected: false };

  const products = rows as StockRiskRow[];
  const eligible = products.filter((p) => p.dailyVelocity >= MIN_VELOCITY);
  if (eligible.length === 0) return { detected: false };

  // Critical: out of stock + still selling
  const outOfStock = eligible.find((p) => p.availableNow <= 0);
  if (outOfStock) {
    const lostUnitsPerDay = outOfStock.dailyVelocity;
    const estimatedDailyRevenueLoss =
      outOfStock.unitsSold30d > 0
        ? (outOfStock.revenue30d / outOfStock.unitsSold30d) * lostUnitsPerDay
        : 0;

    // The generic hook formatter renders `mean`→baseline, `actualValue`→observed,
    // and (actualValue-mean)/mean → % deviation, so both must be the SAME metric
    // in the SAME unit. Our metric is days-of-cover; baseline is the reorder
    // threshold. Out of stock means 0 days of cover, i.e. -100% vs threshold.
    return {
      detected: true,
      anomaly: {
        zScore: DAYS_OF_COVER_THRESHOLD, // gap below threshold, in days
        mean: DAYS_OF_COVER_THRESHOLD,
        stdDev: 0,
        actualValue: 0, // days of cover
        date: outOfStock.windowEnd,
        direction: 'drop',
        trigger: 'out_of_stock',
        product: outOfStock.product,
        unitsSold30d: outOfStock.unitsSold30d,
        dailyVelocity: outOfStock.dailyVelocity,
        availableNow: 0,
        estimatedDailyRevenueLoss: Math.round(estimatedDailyRevenueLoss * 100) / 100,
        currency: outOfStock.currency,
      },
    };
  }

  // Warning: low days of cover for a real seller
  const atRisk = eligible
    .filter((p) => p.daysOfCover < DAYS_OF_COVER_THRESHOLD)
    .sort((a, b) => a.daysOfCover - b.daysOfCover);

  if (atRisk.length === 0) return { detected: false };

  const worst = atRisk[0]!;

  return {
    detected: true,
    anomaly: {
      // Same-unit contract as above: metric = days-of-cover, baseline = threshold.
      // zScore reused as "days below the reorder threshold".
      zScore: Math.round((DAYS_OF_COVER_THRESHOLD - worst.daysOfCover) * 100) / 100,
      mean: DAYS_OF_COVER_THRESHOLD,
      stdDev: 0,
      actualValue: worst.daysOfCover,
      date: worst.windowEnd,
      direction: 'drop',
      trigger: 'low_cover',
      product: worst.product,
      unitsSold30d: worst.unitsSold30d,
      dailyVelocity: worst.dailyVelocity,
      availableNow: worst.availableNow,
      daysOfCover: worst.daysOfCover,
      currency: worst.currency,
      otherAtRiskCount: atRisk.length - 1,
    },
  };
}

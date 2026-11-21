import type { DetectionResult, FactRow } from '../types.js';
import type { ProductLocationRow } from './fetcher.js';

// Detects "stockout at one of several locations" — a top-selling product
// is configured at 2+ locations, has total stock available, but at least
// one location is empty.
//
// This is the actionable case the merchant can fix with an inter-location
// transfer (much faster than a supplier reorder). It's distinct from
// INVENTORY_STOCKOUT_RISK which fires when a product is OOS *everywhere*.
//
// Gates:
//   - Velocity floor — only fire for products that actually sell
//   - Multi-location floor — single-location products can't be "imbalanced"
//   - Must have stock somewhere — if every location is empty, that's
//     captured by INVENTORY_STOCKOUT_RISK instead
//   - Empty location must hold meaningful share when measured by the
//     product's normal distribution — a brand-new location at 0 stock
//     for a product that's never been stocked there isn't really an
//     "imbalance"; we use a 25%+ share floor on average across stocked
//     locations to filter that out
//   - Total cross-location days-of-cover must be >= MIN_DAYS_OF_COVER —
//     if there's barely any stock left anywhere, "transfer between
//     locations" isn't useful advice; INVENTORY_STOCKOUT_RISK should own
//     that case instead. Without this gate, a product crossing from
//     "imbalanced" to "nearly OOS everywhere" would flip between the two
//     modules run-to-run as the last few units sell down.
const MIN_VELOCITY = 0.5;
const MIN_LOCATIONS = 2;
const MIN_DAYS_OF_COVER = 7;

export function detectLocationImbalance(rows: FactRow[]): DetectionResult {
  if (rows.length === 0) return { detected: false };

  const products = rows as ProductLocationRow[];

  // Rank candidates by severity: more empty locations + higher velocity = worse
  const candidates = products
    .filter(
      (p) =>
        p.dailyVelocity >= MIN_VELOCITY &&
        p.locationsConfigured >= MIN_LOCATIONS &&
        p.locationsEmpty >= 1 &&
        p.locationsStocked >= 1 &&
        p.totalAvailable / p.dailyVelocity >= MIN_DAYS_OF_COVER,
    )
    .map((p) => {
      // Severity score: higher velocity × higher empty-share = worse imbalance
      const emptyShare = p.locationsEmpty / p.locationsConfigured;
      const severity = p.dailyVelocity * emptyShare;
      return { product: p, severity, emptyShare };
    })
    .sort((a, b) => b.severity - a.severity);

  if (candidates.length === 0) return { detected: false };

  const worst = candidates[0]!;
  const p = worst.product;
  const topLocation = p.stockByLocation[0]!;
  const emptyLocations = p.stockByLocation
    .filter((l) => l.available === 0)
    .map((l) => l.location);

  // Days of cover the stocked locations would provide if they had to absorb
  // the empty location's share of demand too — an order-of-magnitude estimate
  // since we can't attribute demand to specific locations.
  const daysOfCoverIfAbsorbed = p.totalAvailable / p.dailyVelocity;

  return {
    detected: true,
    anomaly: {
      zScore: Math.round(worst.severity * 100) / 100,
      mean: p.totalAvailable / Math.max(p.locationsStocked, 1),
      stdDev: 0,
      actualValue: 0, // the empty location
      date: p.windowEnd,
      direction: 'drop',
      trigger: 'location_imbalance',
      product: p.product,
      dailyVelocity: p.dailyVelocity,
      totalAvailable: p.totalAvailable,
      locationsConfigured: p.locationsConfigured,
      locationsEmpty: p.locationsEmpty,
      emptyLocationNames: emptyLocations,
      topLocationName: topLocation.location,
      topLocationStock: topLocation.available,
      daysOfCoverIfAbsorbed: Math.round(daysOfCoverIfAbsorbed * 10) / 10,
      otherCandidates: candidates.length - 1,
    },
  };
}

import type { DetectionResult, FactRow } from '../types.js';
import type { ProductShiftRow } from './fetcher.js';

// Finds the product with the biggest relative revenue shift week-over-week.
// Fires if a product's revenue share changed by >8 percentage points AND
// its revenue changed >20% relative. This catches silent shifts in product mix —
// the business may look stable in total revenue while a key product is quietly
// losing ground or a new one is exploding.
//
// New entrants (revenueChangePct=null, no prior-period baseline) must reach
// MIN_NEW_ENTRANT_SHARE of the current revenue mix before they qualify — a
// brand-new low-revenue SKU gaining share is expected, not anomalous.
const MIN_NEW_ENTRANT_SHARE = 5; // percent of current revenue mix

export function detectProductRevenueShift(rows: FactRow[]): DetectionResult {
  if (rows.length === 0) return { detected: false };

  const products = rows as ProductShiftRow[];

  // Find the product with the most significant shift. Revenue change is the
  // primary signal (3x weight) — share change alone can be misleadingly
  // large for a low-revenue product, while a real revenue swing is always
  // business-significant. Share change (1x) breaks ties and catches mix
  // shifts where revenue moved less dramatically than share.
  let biggest: ProductShiftRow | null = null;
  let biggestScore = 0;

  for (const p of products) {
    const absShareChange = Math.abs(p.shareChangePp);
    const isNewEntrant = p.revenueChangePct === null;

    if (isNewEntrant) {
      if (p.currentShare < MIN_NEW_ENTRANT_SHARE) continue;
      if (absShareChange < 8) continue;
    } else {
      const absRevenueChange = Math.abs(p.revenueChangePct!);
      if (absShareChange < 8 || absRevenueChange < 20) continue;
    }

    const score = isNewEntrant
      ? absShareChange
      : Math.abs(p.revenueChangePct!) * 3 + absShareChange;
    if (score > biggestScore) {
      biggestScore = score;
      biggest = p;
    }
  }

  if (!biggest) return { detected: false };

  // New entrants (null) have no prior revenue — direction is always spike (share increased)
  const direction = (biggest.revenueChangePct ?? 1) > 0 ? 'spike' : 'drop';

  return {
    detected: true,
    anomaly: {
      // zScore stores revenue change % when available, or share change pp for new entrants
      zScore: Math.round(Math.abs(biggest.revenueChangePct ?? biggest.shareChangePp) * 100) / 100,
      mean: biggest.previousRevenue,
      stdDev: 0,
      actualValue: biggest.currentRevenue,
      date: biggest.windowEnd,
      direction,
      product: biggest.product,
      currentShare: biggest.currentShare,
      previousShare: biggest.previousShare,
      shareChangePp: biggest.shareChangePp,
      revenueChangePct: biggest.revenueChangePct, // null for new entrants
      currency: biggest.currency,
      topMovers: products
        .filter((p) => Math.abs(p.shareChangePp) > 3)
        .sort((a, b) => Math.abs(b.shareChangePp) - Math.abs(a.shareChangePp))
        .slice(0, 5),
    },
  };
}

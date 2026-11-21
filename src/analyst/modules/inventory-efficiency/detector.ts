import type { DetectionResult, FactRow, AnomalyDetails } from '../types.js';
import type { InventoryEfficiencyRow } from './fetcher.js';

// Merged sell-through-rate + inventory-turn-rate detector.
//
// The two prior modules computed near-identical conditions from the same
// data (a product with ~100 units sold and ~100 on hand sits right at both
// the 50% sell-through boundary AND the 4-turns/year boundary) and fired
// independently — the same SKU produced two separate alerts most weeks.
// This module evaluates both gates per product and assigns a single
// severity: CRITICAL when both signals agree the product is overstocked,
// WARNING when only one does.
const STR_THRESHOLD = 50;        // sell-through % below which the STR gate trips
const STR_MIN_VELOCITY = 0.5;    // units/day
const STR_MIN_AVAILABLE = 5;     // unsold units on hand

const TURNS_THRESHOLD = 4;       // annualized turns below which the turns gate trips
const TURNS_MIN_VELOCITY = 0.3;  // units/day
const TURNS_MIN_AVAILABLE = 10;  // meaningful on-hand quantity

export function detectInventoryEfficiency(rows: FactRow[]): DetectionResult {
  if (rows.length === 0) return { detected: false };

  const products = rows as InventoryEfficiencyRow[];

  const evaluated = products
    .map((p) => {
      const strFlag =
        p.dailyVelocity >= STR_MIN_VELOCITY &&
        p.availableNow >= STR_MIN_AVAILABLE &&
        p.sellThroughRate < STR_THRESHOLD;
      const turnsFlag =
        p.dailyVelocity >= TURNS_MIN_VELOCITY &&
        p.availableNow >= TURNS_MIN_AVAILABLE &&
        p.annualizedTurns < TURNS_THRESHOLD;
      return { product: p, strFlag, turnsFlag };
    })
    .filter((e) => e.strFlag || e.turnsFlag);

  if (evaluated.length === 0) return { detected: false };

  // Critical (both gates trip) first, then worst sell-through within tier.
  evaluated.sort((a, b) => {
    const aCritical = a.strFlag && a.turnsFlag;
    const bCritical = b.strFlag && b.turnsFlag;
    if (aCritical !== bCritical) return aCritical ? -1 : 1;
    return a.product.sellThroughRate - b.product.sellThroughRate;
  });

  const worst = evaluated[0]!;
  const severity = worst.strFlag && worst.turnsFlag ? 'critical' : 'warning';
  const p = worst.product;

  const anomaly: AnomalyDetails = {
    zScore: Math.round((STR_THRESHOLD - p.sellThroughRate) * 100) / 100,
    mean: STR_THRESHOLD,
    stdDev: 0,
    actualValue: p.sellThroughRate,
    date: p.windowEnd,
    direction: 'drop',
    trigger: 'overstock',
    severity,
    product: p.product,
    unitsSold30d: p.unitsSold30d,
    availableNow: p.availableNow,
    sellThroughRate: p.sellThroughRate,
    annualizedTurns: p.annualizedTurns === Number.POSITIVE_INFINITY ? null : p.annualizedTurns,
    daysOfStock: p.daysOfStock === Number.POSITIVE_INFINITY ? null : p.daysOfStock,
    dailyVelocity: p.dailyVelocity,
    currency: p.currency,
    strFlagged: worst.strFlag,
    turnsFlagged: worst.turnsFlag,
    otherAtRiskCount: evaluated.length - 1,
  };

  return { detected: true, anomaly };
}

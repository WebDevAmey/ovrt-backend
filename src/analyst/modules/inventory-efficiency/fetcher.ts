import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getTopProductsBySales, getInventoryLevels } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type InventoryEfficiencyRow = {
  product: string;
  unitsSold30d: number;
  availableNow: number;
  sellThroughRate: number; // unitsSold / (unitsSold + availableNow) * 100
  annualizedTurns: number; // (unitsSold30d * 365/30) / availableNow
  daysOfStock: number;     // availableNow / (unitsSold30d / 30); Infinity if velocity is 0
  dailyVelocity: number;
  currency: string;
  windowEnd: string;
};

const VELOCITY_WINDOW_DAYS = 30;
const ANNUALIZE_FACTOR = 365 / VELOCITY_WINDOW_DAYS; // ~12.17

/**
 * Combined fetch for both inventory-efficiency signals — sell-through rate
 * and annualized turns — from the same sales+inventory join. Previously
 * sell-through-rate and inventory-turn-rate each ran this fetch separately
 * and fired independently on the same overstocked SKUs, producing
 * duplicate alerts; see detector.ts for the merged severity logic.
 */
export async function fetchInventoryEfficiency(integrationId: string): Promise<InventoryEfficiencyRow[]> {
  const conn = await getShopifyConn(integrationId);
  const windowEnd = daysAgoStr(1);

  const [salesResult, inventoryResult] = await Promise.all([
    getTopProductsBySales(conn, {
      since: daysAgoStr(VELOCITY_WINDOW_DAYS),
      until: windowEnd,
      limit: 20,
    }),
    getInventoryLevels(conn, { lowStockThreshold: 1 }),
  ]);

  type Sale = { product: string; units: number; revenue: number; currency: string };
  const sales = salesResult.rows as Sale[];
  if (sales.length === 0) return [];

  const currency = sales[0]?.currency ?? '';

  const stockByProduct = new Map<string, number>();
  for (const row of inventoryResult.rows) {
    const product = String(row.product ?? '');
    const available = Number(row.available ?? 0);
    if (!product) continue;
    stockByProduct.set(product, (stockByProduct.get(product) ?? 0) + available);
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  const rows: InventoryEfficiencyRow[] = [];
  for (const s of sales) {
    const availableNow = stockByProduct.get(s.product);
    if (availableNow === undefined) continue; // no tracked inventory → skip

    const dailyVelocity = s.units / VELOCITY_WINDOW_DAYS;
    const total = s.units + availableNow;
    const sellThroughRate = total > 0 ? (s.units / total) * 100 : 0;
    const annualizedTurns = availableNow > 0 ? (s.units * ANNUALIZE_FACTOR) / availableNow : Number.POSITIVE_INFINITY;
    const daysOfStock = dailyVelocity > 0 ? availableNow / dailyVelocity : Number.POSITIVE_INFINITY;

    rows.push({
      product: s.product,
      unitsSold30d: s.units,
      availableNow,
      sellThroughRate: round2(sellThroughRate),
      annualizedTurns: annualizedTurns === Number.POSITIVE_INFINITY ? annualizedTurns : round2(annualizedTurns),
      daysOfStock: daysOfStock === Number.POSITIVE_INFINITY ? daysOfStock : round2(daysOfStock),
      dailyVelocity: round2(dailyVelocity),
      currency,
      windowEnd,
    });
  }

  return rows.sort((a, b) => a.sellThroughRate - b.sellThroughRate);
}

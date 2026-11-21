import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import {
  getTopProductsBySales,
  getInventoryLevels,
} from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type LocationStock = {
  location: string;
  available: number;
};

export type ProductLocationRow = {
  product: string;
  unitsSold30d: number;
  dailyVelocity: number;
  totalAvailable: number;
  locationsConfigured: number;     // locations where this product appears AT ALL (any variant)
  locationsStocked: number;        // locations with available > 0
  locationsEmpty: number;          // locations with available == 0
  stockByLocation: LocationStock[]; // sorted desc by available
  windowEnd: string;
};

const VELOCITY_WINDOW_DAYS = 30;

/**
 * Joins 30-day sales velocity with per-location stock for top-selling products.
 *
 * Aggregation grain: (product title, location) — sums across variants. This
 * matches `getTopProductsBySales` which aggregates by product title.
 *
 * A product appears in `stockByLocation` only for locations where it's actually
 * configured (Shopify's inventoryLevels connection omits non-configured
 * combinations). So `locationsConfigured` reflects the real multi-location
 * spread set up by the merchant, not the store's total location count.
 */
export async function fetchLocationStock(integrationId: string): Promise<ProductLocationRow[]> {
  const conn = await getShopifyConn(integrationId);
  const windowEnd = daysAgoStr(1);

  const [salesResult, inventoryResult] = await Promise.all([
    getTopProductsBySales(conn, {
      since: daysAgoStr(VELOCITY_WINDOW_DAYS),
      until: windowEnd,
      limit: 10,
    }),
    getInventoryLevels(conn, { lowStockThreshold: 1 }),
  ]);

  type Sale = { product: string; units: number; revenue: number; currency: string };
  const sales = salesResult.rows as Sale[];
  if (sales.length === 0) return [];

  // Build a (product → location → totalAvailable) map by summing variants
  const stockMap = new Map<string, Map<string, number>>();
  for (const row of inventoryResult.rows) {
    const product = String(row.product ?? '');
    const location = String(row.location ?? '');
    const available = Number(row.available ?? 0);
    if (!product || !location) continue;

    const byLoc = stockMap.get(product) ?? new Map<string, number>();
    byLoc.set(location, (byLoc.get(location) ?? 0) + available);
    stockMap.set(product, byLoc);
  }

  const rows: ProductLocationRow[] = [];

  for (const s of sales) {
    const byLocation = stockMap.get(s.product);
    if (!byLocation) continue;

    const stockByLocation: LocationStock[] = Array.from(byLocation.entries())
      .map(([location, available]) => ({ location, available }))
      .sort((a, b) => b.available - a.available);

    const totalAvailable = stockByLocation.reduce((sum, l) => sum + l.available, 0);
    const locationsConfigured = stockByLocation.length;
    const locationsStocked = stockByLocation.filter((l) => l.available > 0).length;
    const locationsEmpty = locationsConfigured - locationsStocked;

    rows.push({
      product: s.product,
      unitsSold30d: s.units,
      dailyVelocity: Math.round((s.units / VELOCITY_WINDOW_DAYS) * 100) / 100,
      totalAvailable,
      locationsConfigured,
      locationsStocked,
      locationsEmpty,
      stockByLocation,
      windowEnd,
    });
  }

  return rows;
}

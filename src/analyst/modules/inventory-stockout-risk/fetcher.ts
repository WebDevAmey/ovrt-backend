import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import {
  getTopProductsBySales,
  getInventoryLevels,
} from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type StockRiskRow = {
  product: string;
  unitsSold30d: number;
  revenue30d: number;
  dailyVelocity: number; // units / day
  availableNow: number;  // sum across variants and locations
  variantCount: number;
  daysOfCover: number;   // availableNow / dailyVelocity (Number.POSITIVE_INFINITY if velocity == 0)
  currency: string;
  windowEnd: string;
};

const VELOCITY_WINDOW_DAYS = 30;

/**
 * Joins 30-day sales velocity (Shopify orders) with current inventory levels
 * (Shopify inventory). One row per product title that appears in the
 * top-20-by-revenue list AND has tracked inventory.
 *
 * Aggregation note: `getTopProductsBySales` groups by lineItem.title — the
 * product title (not variant). `getInventoryLevels` returns one row per
 * (variant, location). We sum `available` across all of them per product so
 * the velocity and inventory comparisons use a consistent product-level grain.
 */
export async function fetchStockRisk(integrationId: string): Promise<StockRiskRow[]> {
  const conn = await getShopifyConn(integrationId);
  const windowEnd = daysAgoStr(1);

  const [salesResult, inventoryResult] = await Promise.all([
    getTopProductsBySales(conn, {
      since: daysAgoStr(VELOCITY_WINDOW_DAYS),
      until: windowEnd,
      limit: 20,
    }),
    // lowStockThreshold only affects the `status` field; we get every tracked variant
    getInventoryLevels(conn, { lowStockThreshold: 1 }),
  ]);

  type Sale = { product: string; units: number; revenue: number; currency: string };
  const sales = salesResult.rows as Sale[];
  if (sales.length === 0) return [];

  type Inv = { product: string; available: number };
  const inv = inventoryResult.rows as Array<Record<string, unknown>>;

  // Sum available qty across all (variant, location) rows for a product title.
  // Variants of the same product share inventory pools at the product-title grain,
  // which matches how velocity is computed above. Variant-level cover would be
  // more precise but `getTopProductsBySales` doesn't split velocity by variant.
  const stockByProduct = new Map<string, { available: number; variantCount: number }>();
  for (const row of inv) {
    const product = String(row.product ?? '');
    const available = Number(row.available ?? 0);
    const prev = stockByProduct.get(product) ?? { available: 0, variantCount: 0 };
    stockByProduct.set(product, {
      available: prev.available + available,
      variantCount: prev.variantCount + 1,
    });
  }

  const currency = sales[0]?.currency ?? '';
  const rows: StockRiskRow[] = [];

  for (const s of sales) {
    const stock = stockByProduct.get(s.product);
    if (!stock) continue; // product has no tracked inventory — skip (likely service/digital)

    const dailyVelocity = s.units / VELOCITY_WINDOW_DAYS;
    const daysOfCover =
      dailyVelocity > 0
        ? stock.available / dailyVelocity
        : Number.POSITIVE_INFINITY;

    rows.push({
      product: s.product,
      unitsSold30d: s.units,
      revenue30d: Math.round(s.revenue * 100) / 100,
      dailyVelocity: Math.round(dailyVelocity * 100) / 100,
      availableNow: stock.available,
      variantCount: stock.variantCount,
      daysOfCover:
        daysOfCover === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : Math.round(daysOfCover * 10) / 10,
      currency,
      windowEnd,
    });
  }

  // Sort by riskiest first so the detector and prompt see the right product up front
  rows.sort((a, b) => {
    const aCover = a.daysOfCover === Number.POSITIVE_INFINITY ? 9999 : a.daysOfCover;
    const bCover = b.daysOfCover === Number.POSITIVE_INFINITY ? 9999 : b.daysOfCover;
    return aCover - bCover;
  });

  return rows;
}

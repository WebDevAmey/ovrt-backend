import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getTopProductsBySales } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type ProductShiftRow = {
  product: string;
  currentRevenue: number;
  previousRevenue: number;
  currentShare: number;   // % of total revenue this period
  previousShare: number;
  shareChangePp: number;  // percentage point change in share
  revenueChangePct: number | null; // relative revenue change %; null = new entrant (prevRev was 0)
  currency: string;
  windowEnd: string;      // end date of the current data window (YYYY-MM-DD)
};

export async function fetchProductRevenueShift(integrationId: string): Promise<ProductShiftRow[]> {
  const conn = await getShopifyConn(integrationId);

  const [curr, prev] = await Promise.all([
    getTopProductsBySales(conn, { since: daysAgoStr(14), until: daysAgoStr(1), limit: 15 }),
    getTopProductsBySales(conn, { since: daysAgoStr(28), until: daysAgoStr(15), limit: 15 }),
  ]);

  type PRow = { product: string; revenue: number; units: number; currency: string };
  const currRows = curr.rows as PRow[];
  const prevRows = prev.rows as PRow[];

  const currTotal = currRows.reduce((s, r) => s + r.revenue, 0);
  const prevTotal = prevRows.reduce((s, r) => s + r.revenue, 0);

  if (currTotal === 0 || prevTotal === 0) return [];

  const currency = currRows[0]?.currency ?? prevRows[0]?.currency ?? '';
  const windowEnd = daysAgoStr(1);
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Build lookup maps and merge both windows so we catch risers AND fallers.
  // Products only in the previous window (dropped off top-N) get currRev=0.
  // Products only in the current window (new entrants) get prevRev=0.
  const currRevMap = new Map(currRows.map((r) => [r.product, r]));
  const prevRevMap = new Map(prevRows.map((r) => [r.product, r]));
  const allProducts = new Set([...currRevMap.keys(), ...prevRevMap.keys()]);

  const rows: ProductShiftRow[] = Array.from(allProducts).map((product) => {
    const c = currRevMap.get(product);
    const p = prevRevMap.get(product);
    const currRev = c?.revenue ?? 0;
    const prevRev = p?.revenue ?? 0;

    const currShare = currTotal > 0 ? (currRev / currTotal) * 100 : 0;
    const prevShare = prevTotal > 0 ? (prevRev / prevTotal) * 100 : 0;

    // null for new entrants: prevRev=0 means there is no prior baseline to compute
    // a percentage change against. For products that dropped off the top-N list,
    // currRev=0 yields -100% (conservative — actual drop may be less, but the
    // direction and magnitude are correct for detection purposes).
    const revenueChangePct = prevRev > 0
      ? ((currRev - prevRev) / prevRev) * 100
      : null;

    return {
      product,
      currentRevenue: round2(currRev),
      previousRevenue: round2(prevRev),
      currentShare: round2(currShare),
      previousShare: round2(prevShare),
      shareChangePp: round2(currShare - prevShare),
      revenueChangePct: revenueChangePct !== null ? round2(revenueChangePct) : null,
      currency: c?.currency ?? p?.currency ?? currency,
      windowEnd,
    };
  });

  return rows;
}

import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { queryOrdersWithDiscounts, INVENTORY_PAGE_SIZE, MAX_INVENTORY_PAGES } from '../../../agents/shopify/queries.js';
import { buildOrderQuery, isoDate } from '../../../agents/shopify/helpers.js';

export { resolveShopifySource };

export type DiscountCodeDailyRow = {
  code: string;
  date: string; // YYYY-MM-DD
  uses: number;
  totalDiscount: number;
  totalRevenue: number;
  currency: string;
};

// 9 weeks: enough for seasonalCusum's day-of-week baselines (8 weeks of
// history) plus the most recent 7-day test window, on each code's daily
// redemption count.
const LOOKBACK_DAYS = 63;

/**
 * Fetches every order with a discount code over 63 days, bucketed by
 * (code, day). One paginated query covers the whole window — bucketing by
 * day client-side from each order's createdAt avoids 63 separate API calls.
 */
export async function fetchDiscountCodeDailySeries(integrationId: string): Promise<DiscountCodeDailyRow[]> {
  const conn = await getShopifyConn(integrationId);
  const since = daysAgoStr(LOOKBACK_DAYS);
  const until = daysAgoStr(1);
  const queryString = buildOrderQuery({ since, until });

  const byKey = new Map<string, DiscountCodeDailyRow>();
  let cursor: string | null = null;
  let page = 0;
  let currency = conn.currency ?? '';

  while (page < MAX_INVENTORY_PAGES) {
    const data = await queryOrdersWithDiscounts(conn, INVENTORY_PAGE_SIZE, queryString || null, cursor);

    for (const { node } of data.orders.edges) {
      if (node.discountCodes.length === 0) continue;
      if (!currency) currency = node.currentTotalPriceSet.shopMoney.currencyCode;

      const date = isoDate(new Date(node.createdAt));
      const revenue = parseFloat(node.currentTotalPriceSet.shopMoney.amount) || 0;
      const discount = node.totalDiscountsSet ? parseFloat(node.totalDiscountsSet.shopMoney.amount) || 0 : 0;

      for (const code of node.discountCodes) {
        const key = `${code}::${date}`;
        const existing = byKey.get(key) ?? { code, date, uses: 0, totalDiscount: 0, totalRevenue: 0, currency };
        existing.uses += 1;
        existing.totalDiscount += discount;
        existing.totalRevenue += revenue;
        byKey.set(key, existing);
      }
    }

    page++;
    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
    if (!cursor) break;
  }

  return Array.from(byKey.values());
}

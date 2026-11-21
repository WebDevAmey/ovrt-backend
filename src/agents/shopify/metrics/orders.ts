/**
 * Order metrics: summary, time series, and checkout abandonment analysis
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult, isoDate, buildOrderQuery, bucketKey, fetchOrderPages } from '../helpers.js';

export type OrdersSummaryInput = {
  since: string; // YYYY-MM-DD
  until?: string | null; // YYYY-MM-DD, defaults to today
  financialStatus?: string | null;
};

export async function getOrdersSummary(
  conn: ShopifyConnectInfo,
  input: OrdersSummaryInput,
): Promise<RecordResult> {
  const queryString = buildOrderQuery({
    since: input.since,
    until: input.until ?? isoDate(new Date()),
    financialStatus: input.financialStatus ?? null,
  });
  const { orders, truncated, currency } = await fetchOrderPages(conn, queryString, {
    includeLineItems: false,
  });

  let gross = 0;
  let discounts = 0;
  const customerIds = new Set<string>();
  for (const o of orders) {
    gross += Number(o.currentTotalPriceSet.shopMoney.amount);
    if (o.totalDiscountsSet) discounts += Number(o.totalDiscountsSet.shopMoney.amount);
    if (o.customer?.id) customerIds.add(o.customer.id);
  }

  const aov = orders.length > 0 ? gross / orders.length : 0;

  const row = {
    since: input.since,
    until: input.until ?? isoDate(new Date()),
    financialStatus: input.financialStatus ?? 'any',
    orderCount: orders.length,
    totalSales: Math.round(gross * 100) / 100,
    totalDiscounts: Math.round(discounts * 100) / 100,
    averageOrderValue: Math.round(aov * 100) / 100,
    uniqueCustomers: customerIds.size,
    currency,
    truncated,
  };
  return rowsToResult([row], truncated);
}

export type Granularity = 'day' | 'week' | 'month';

export type OrdersTimeSeriesInput = {
  since: string;
  until?: string | null;
  granularity: Granularity;
  financialStatus?: string | null;
};

export async function getOrdersTimeSeries(
  conn: ShopifyConnectInfo,
  input: OrdersTimeSeriesInput,
): Promise<RecordResult> {
  const queryString = buildOrderQuery({
    since: input.since,
    until: input.until ?? isoDate(new Date()),
    financialStatus: input.financialStatus ?? null,
  });
  const { orders, truncated, currency } = await fetchOrderPages(conn, queryString, {
    includeLineItems: false,
  });

  const buckets = new Map<string, { count: number; sales: number }>();
  for (const o of orders) {
    const key = bucketKey(new Date(o.createdAt), input.granularity);
    const cur = buckets.get(key) ?? { count: 0, sales: 0 };
    cur.count += 1;
    cur.sales += Number(o.currentTotalPriceSet.shopMoney.amount);
    buckets.set(key, cur);
  }

  const rows = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([period, v]) => ({
      period,
      orderCount: v.count,
      sales: Math.round(v.sales * 100) / 100,
      currency,
    }));

  return rowsToResult(rows, truncated);
}

export type CheckoutAbandonmentInput = {
  since: string;       // YYYY-MM-DD, inclusive
  until?: string | null;
};

export async function getCheckoutAbandonment(
  conn: ShopifyConnectInfo,
  input: CheckoutAbandonmentInput,
): Promise<RecordResult> {
  const { queryAbandonedCheckouts } = await import('../queries.js');
  const { MAX_AGGREGATE_PAGES_EXPORT: MAX_AGGREGATE_PAGES, PAGE_SIZE_EXPORT: PAGE_SIZE } = await import('../helpers.js');

  const until = input.until ?? isoDate(new Date());
  const checkoutQuery = `created_at:>='${input.since}T00:00:00Z' created_at:<='${until}T23:59:59Z'`;

  let abandonedCount = 0;
  let abandonedValue = 0;
  let currency: string | null = null;
  let cursor: string | null = null;
  let page = 0;
  let truncated = false;

  while (page < MAX_AGGREGATE_PAGES) {
    const data = await queryAbandonedCheckouts(conn, PAGE_SIZE, checkoutQuery, cursor);

    for (const { node } of data.abandonedCheckouts.edges) {
      abandonedCount++;
      abandonedValue += parseFloat(node.totalPriceSet.shopMoney.amount) || 0;
      if (!currency) currency = node.totalPriceSet.shopMoney.currencyCode;
    }

    page++;
    if (!data.abandonedCheckouts.pageInfo.hasNextPage) break;
    if (page >= MAX_AGGREGATE_PAGES) { truncated = true; break; }
    cursor = data.abandonedCheckouts.pageInfo.endCursor;
    if (!cursor) break;
  }

  // Completed orders (anyone who finished checkout in the window)
  const orderQueryString = buildOrderQuery({ since: input.since, until });
  const { orders, truncated: ordersTruncated, currency: orderCurrency } =
    await fetchOrderPages(conn, orderQueryString, { includeLineItems: false });
  const completedCount = orders.length;
  if (!currency) currency = orderCurrency;

  const totalCheckouts = abandonedCount + completedCount;
  const abandonmentRate =
    totalCheckouts > 0 ? (abandonedCount / totalCheckouts) * 100 : 0;

  const row = {
    since: input.since,
    until,
    abandonedCheckouts: abandonedCount,
    completedCheckouts: completedCount,
    totalCheckouts,
    abandonmentRate: Math.round(abandonmentRate * 100) / 100,
    abandonedValue: Math.round(abandonedValue * 100) / 100,
    currency: currency ?? '',
    truncated: truncated || ordersTruncated,
  };
  return rowsToResult([row], truncated || ordersTruncated);
}

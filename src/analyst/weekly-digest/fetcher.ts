import { resolveShopifySource, getShopifyConn } from '../modules/shopify-shared.js';
import {
  getOrdersSummary,
  getTopProductsBySales,
  getRefundAnalysis,
  getCustomerRetentionStats,
  getCheckoutAbandonment,
  getDiscountPerformance,
  getInventoryLevels,
  getOrdersTimeSeries,
} from '../../agents/shopify/functions.js';
import type {
  DigestStoreMetrics,
  DigestTopProduct,
  DigestRefundedProduct,
  DigestDiscountCode,
  DigestLowStockItem,
  DigestDailyPoint,
} from './types.js';
import { BUSINESS_TIMEZONE } from '../constants.js';

export { resolveShopifySource };

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface DigestWindow {
  weekStart: string;      // YYYY-MM-DD  Monday of the digest week
  weekEnd: string;        // YYYY-MM-DD  Sunday of the digest week
  priorWeekStart: string; // YYYY-MM-DD  Monday of the week before
  priorWeekEnd: string;   // YYYY-MM-DD  Sunday of the week before
}

/**
 * Returns the most recently completed ISO week (Mon → Sun) and the
 * week immediately before it. Designed to run on Monday morning IST:
 * "last week" is the Mon–Sun that just closed.
 */
export function computeDigestWindow(
  now: Date = new Date(),
  timeZone = BUSINESS_TIMEZONE,
): DigestWindow {
  // Resolve "today" as the calendar date in the business timezone (IST) so a
  // Monday-morning trigger from ahead-of-UTC zones does not land on a
  // UTC-Sunday and select the wrong week.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);

  const today = new Date(Date.UTC(y, m - 1, d));

  // ISO weekday: Mon=1 … Sun=7. Convert JS 0=Sun.
  const dow = today.getUTCDay() || 7;

  // Monday of the current week
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - (dow - 1));

  // The digest covers last week: Mon → Sun immediately before thisMonday
  const digestSunday = new Date(thisMonday);
  digestSunday.setUTCDate(thisMonday.getUTCDate() - 1);
  const digestMonday = new Date(thisMonday);
  digestMonday.setUTCDate(thisMonday.getUTCDate() - 7);

  // Prior week for WoW comparison
  const priorSunday = new Date(digestMonday);
  priorSunday.setUTCDate(digestMonday.getUTCDate() - 1);
  const priorMonday = new Date(digestMonday);
  priorMonday.setUTCDate(digestMonday.getUTCDate() - 7);

  return {
    weekStart: toIsoDate(digestMonday),
    weekEnd: toIsoDate(digestSunday),
    priorWeekStart: toIsoDate(priorMonday),
    priorWeekEnd: toIsoDate(priorSunday),
  };
}

export async function fetchDigestData(
  integrationId: string,
  window: DigestWindow,
): Promise<DigestStoreMetrics> {
  const conn = await getShopifyConn(integrationId);

  // Fetches run sequentially to avoid saturating Shopify's rate-limit bucket.
  // Each helper is itself paginated (up to 8 pages × 250 rows), so firing them
  // concurrently can push 50+ requests at once and trigger 429 → retry →
  // 30 s timeout. Sequential adds latency to a background job — acceptable.
  const currentSummary = await getOrdersSummary(conn, { since: window.weekStart, until: window.weekEnd });
  const priorSummary = await getOrdersSummary(conn, { since: window.priorWeekStart, until: window.priorWeekEnd });
  const topProducts = await getTopProductsBySales(conn, { since: window.weekStart, until: window.weekEnd, limit: 10 });
  const refunds = await getRefundAnalysis(conn, { since: window.weekStart, until: window.weekEnd });
  const customerStats = await getCustomerRetentionStats(conn, { since: window.weekStart, until: window.weekEnd });
  const priorCustomerStats = await getCustomerRetentionStats(conn, { since: window.priorWeekStart, until: window.priorWeekEnd });
  const abandonment = await getCheckoutAbandonment(conn, { since: window.weekStart, until: window.weekEnd });
  const discounts = await getDiscountPerformance(conn, { since: window.weekStart, until: window.weekEnd });
  const dailySeries = await getOrdersTimeSeries(conn, { since: window.weekStart, until: window.weekEnd, granularity: 'day' });
  // Inventory is a point-in-time snapshot (no date window) — current stock health.
  const inventory = await getInventoryLevels(conn, { lowStockThreshold: 10 });

  const cur = currentSummary.rows[0] as Record<string, unknown>;
  const pri = priorSummary.rows[0] as Record<string, unknown>;
  // refunds.rows[0] is the summary row (rowType='summary'); the rest are per-product.
  const refundRow = (refunds.rows.find(
    (r) => (r as Record<string, unknown>).rowType === 'summary',
  ) ?? refunds.rows[0]) as Record<string, unknown>;
  const custRow = customerStats.rows[0] as Record<string, unknown>;
  const priorCustRow = priorCustomerStats.rows[0] as Record<string, unknown>;
  const abanRow = abandonment.rows[0] as Record<string, unknown>;
  const discountRow = (discounts.rows.find(
    (r) => (r as Record<string, unknown>).rowType === 'summary',
  ) ?? discounts.rows[0]) as Record<string, unknown>;

  const products: DigestTopProduct[] = topProducts.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      product: (row.product as string) ?? '',
      units: (row.units as number) ?? 0,
      revenue: (row.revenue as number) ?? 0,
    };
  });

  // Per-product refund breakdown (rowType='product'); top 5 keeps the prompt tight.
  const refundedProducts: DigestRefundedProduct[] = refunds.rows
    .filter((r) => (r as Record<string, unknown>).rowType === 'product')
    .slice(0, 5)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        product: (row.product as string) ?? '(unknown)',
        unitsRefunded: (row.unitsRefunded as number) ?? 0,
        refundOccurrences: (row.refundOccurrences as number) ?? 0,
      };
    });

  // Discount codes are every row except the summary; top 5 by usage.
  const topDiscountCodes: DigestDiscountCode[] = discounts.rows
    .filter((r) => (r as Record<string, unknown>).rowType !== 'summary')
    .slice(0, 5)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return {
        code: (row.code as string) ?? '',
        timesUsed: (row.timesUsed as number) ?? 0,
        totalDiscount: (row.totalDiscount as number) ?? 0,
        totalRevenue: (row.totalRevenue as number) ?? 0,
      };
    });

  // Inventory rows are pre-sorted OUT_OF_STOCK → LOW_STOCK → OK. Surface only
  // the at-risk items (top 8) plus counts so the LLM can flag restocks.
  const lowStockItems: DigestLowStockItem[] = [];
  let outOfStockCount = 0;
  let lowStockCount = 0;
  for (const r of inventory.rows) {
    const row = r as Record<string, unknown>;
    const status = row.status as string;
    if (status === 'OUT_OF_STOCK') outOfStockCount++;
    else if (status === 'LOW_STOCK') lowStockCount++;
    else continue;
    if (lowStockItems.length < 8) {
      lowStockItems.push({
        product: (row.product as string) ?? '',
        variant: (row.variant as string) ?? '',
        available: (row.available as number) ?? 0,
        status: status as DigestLowStockItem['status'],
      });
    }
  }

  const dailyTrend: DigestDailyPoint[] = dailySeries.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      date: (row.period as string) ?? '',
      orders: (row.orderCount as number) ?? 0,
      revenue: (row.sales as number) ?? 0,
    };
  });

  const truncated = Boolean(
    currentSummary.truncated ||
      priorSummary.truncated ||
      topProducts.truncated ||
      refunds.truncated ||
      customerStats.truncated ||
      abandonment.truncated ||
      discounts.truncated ||
      dailySeries.truncated ||
      inventory.truncated,
  );

  return {
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    currency: (cur?.currency as string) ?? '',
    totalRevenue: (cur?.totalSales as number) ?? 0,
    totalOrders: (cur?.orderCount as number) ?? 0,
    averageOrderValue: (cur?.averageOrderValue as number) ?? 0,
    uniqueCustomers: (cur?.uniqueCustomers as number) ?? 0,
    totalDiscounts: (cur?.totalDiscounts as number) ?? 0,
    newlyRegisteredCustomers: (custRow?.newCustomers as number) ?? 0,
    refundRate: (refundRow?.refundRate as number) ?? 0,
    totalRefunded: (refundRow?.totalRefunded as number) ?? 0,
    refundedProducts,
    discountUptakeRate: (discountRow?.discountUptakeRate as number) ?? 0,
    topDiscountCodes,
    abandonmentRate: (abanRow?.abandonmentRate as number) ?? 0,
    abandonedValue: (abanRow?.abandonedValue as number) ?? 0,
    outOfStockCount,
    lowStockCount,
    lowStockItems,
    topProducts: products,
    dailyTrend,
    priorWeekRevenue: (pri?.totalSales as number) ?? 0,
    priorWeekOrders: (pri?.orderCount as number) ?? 0,
    priorWeekAov: (pri?.averageOrderValue as number) ?? 0,
    priorWeekNewlyRegistered: (priorCustRow?.newCustomers as number) ?? 0,
    truncated,
  };
}

import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import {
  getFulfillmentSummary,
  getOrdersSummary,
} from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type FulfillmentSummaryRow = {
  rowType: 'summary';
  totalRecentOrders: number;        // total orders in last 7 days (denominator)
  agedCount: number;                // unfulfilled orders aged >= AGED_DAYS_THRESHOLD
  agedRatio: number;                // agedCount / max(totalRecentOrders, 1)
  medianAgedDays: number;           // median days unfulfilled across aged orders
  maxAgedDays: number;              // worst single aged order
  totalUnfulfilledAny: number;      // all currently unfulfilled, any age (informational)
  modalDayRatio: number;            // share of agedCount sharing the same daysUnfulfilled value
  windowEnd: string;
};

export type FulfillmentAgedOrderRow = {
  rowType: 'order';
  orderNumber: string;
  daysUnfulfilled: number;
  items: string;
  shippingCity: string | null;
  shippingCountry: string | null;
};

export type FulfillmentRow = FulfillmentSummaryRow | FulfillmentAgedOrderRow;

const AGED_DAYS_THRESHOLD = 3;
const LOOKBACK_DAYS = 30;

export async function fetchFulfillmentDelays(integrationId: string): Promise<FulfillmentRow[]> {
  const conn = await getShopifyConn(integrationId);
  const windowEnd = daysAgoStr(1);

  const [fulfillment, recent] = await Promise.all([
    // Pulls all currently-unfulfilled orders created in last 30 days.
    // daysUnfulfilled is precomputed by the helper.
    getFulfillmentSummary(conn, { since: daysAgoStr(LOOKBACK_DAYS) }),
    // Used as denominator for relative ratio so the signal scales with merchant size
    getOrdersSummary(conn, {
      since: daysAgoStr(7),
      until: windowEnd,
    }),
  ]);

  const unfulfilled = fulfillment.rows as Array<{
    orderNumber: string;
    daysUnfulfilled: number;
    items: string;
    shippingCity: string | null;
    shippingCountry: string | null;
  }>;

  const aged = unfulfilled.filter((o) => o.daysUnfulfilled >= AGED_DAYS_THRESHOLD);
  const totalRecentOrders = Number(
    (recent.rows[0] as Record<string, unknown>)?.orderCount ?? 0,
  );

  // Median age across aged orders (robust to one extreme outlier)
  const sortedAges = aged
    .map((o) => o.daysUnfulfilled)
    .sort((a, b) => a - b);
  const medianAgedDays =
    sortedAges.length === 0
      ? 0
      : sortedAges.length % 2 === 1
        ? sortedAges[Math.floor(sortedAges.length / 2)]!
        : (sortedAges[sortedAges.length / 2 - 1]! + sortedAges[sortedAges.length / 2]!) / 2;

  const maxAgedDays = sortedAges.length > 0 ? sortedAges[sortedAges.length - 1]! : 0;

  // Orders that share the exact same daysUnfulfilled value were created on
  // the same calendar day. A backlog dominated by a single day (e.g. a
  // courier missed one pickup) is a different — usually lower-severity —
  // signal than a backlog spread across several days, which indicates a
  // sustained, growing problem rather than a one-off blip.
  const byDaysUnfulfilled = new Map<number, number>();
  for (const days of sortedAges) {
    byDaysUnfulfilled.set(days, (byDaysUnfulfilled.get(days) ?? 0) + 1);
  }
  const modalDayCount = Math.max(0, ...byDaysUnfulfilled.values());
  const modalDayRatio = aged.length > 0 ? modalDayCount / aged.length : 0;

  const summary: FulfillmentSummaryRow = {
    rowType: 'summary',
    totalRecentOrders,
    agedCount: aged.length,
    agedRatio: totalRecentOrders > 0 ? aged.length / totalRecentOrders : 0,
    medianAgedDays,
    maxAgedDays,
    totalUnfulfilledAny: unfulfilled.length,
    modalDayRatio: Math.round(modalDayRatio * 1000) / 1000,
    windowEnd,
  };

  // Include the worst 5 aged orders for context in the LLM prompt
  const worstAged: FulfillmentAgedOrderRow[] = aged
    .sort((a, b) => b.daysUnfulfilled - a.daysUnfulfilled)
    .slice(0, 5)
    .map((o) => ({
      rowType: 'order' as const,
      orderNumber: o.orderNumber,
      daysUnfulfilled: o.daysUnfulfilled,
      items: o.items,
      shippingCity: o.shippingCity,
      shippingCountry: o.shippingCountry,
    }));

  return [summary, ...worstAged];
}

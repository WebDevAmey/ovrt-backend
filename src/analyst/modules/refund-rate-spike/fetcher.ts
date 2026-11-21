import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getRefundAnalysis } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type RefundSummaryRow = {
  rowType: 'summary';
  windowStart: string;
  windowEnd: string;
  totalOrders: number;
  ordersWithRefunds: number;
  refundRate: number; // percentage
  totalRefunded: number;
  currency: string;
};

export type RefundProductRow = {
  period: 'current' | 'previous';
  rowType: 'product';
  product: string;
  refundOccurrences: number;
  unitsRefunded: number;
};

// 8 overlapping 14-day windows stepped by 7 days, for the EWMA control chart
// on overall refund rate (trigger 1). The two most recent windows (current,
// previous) also carry per-product breakdown for the product-surge trigger
// (trigger 2) — no extra Shopify calls needed since getRefundAnalysis
// already returns product rows alongside the summary.
const SNAPSHOT_COUNT = 8;
const WINDOW_DAYS = 14;
const STEP_DAYS = 7;

export async function fetchRefundWindows(
  integrationId: string,
): Promise<Array<RefundSummaryRow | RefundProductRow>> {
  const conn = await getShopifyConn(integrationId);

  const offsets = Array.from({ length: SNAPSHOT_COUNT }, (_, i) => i * STEP_DAYS);
  const results = await Promise.all(
    offsets.map((offset) =>
      getRefundAnalysis(conn, {
        since: daysAgoStr(WINDOW_DAYS + offset),
        until: daysAgoStr(1 + offset),
      }),
    ),
  );

  const summaries: RefundSummaryRow[] = offsets.map((offset, idx) => {
    const r = results[idx]!;
    const s = r.rows.find((row) => (row as Record<string, unknown>).rowType === 'summary') as
      | Record<string, unknown>
      | undefined;
    return {
      rowType: 'summary' as const,
      windowStart: daysAgoStr(WINDOW_DAYS + offset),
      windowEnd: daysAgoStr(1 + offset),
      totalOrders: Number(s?.totalOrders ?? 0),
      ordersWithRefunds: Number(s?.ordersWithRefunds ?? 0),
      refundRate: Number(s?.refundRate ?? 0),
      totalRefunded: Number(s?.totalRefunded ?? 0),
      currency: String(s?.currency ?? ''),
    };
  });

  const toProducts = (period: 'current' | 'previous', r: typeof results[number]): RefundProductRow[] =>
    r.rows
      .filter((row) => (row as Record<string, unknown>).rowType === 'product')
      .map((row) => {
        const p = row as Record<string, unknown>;
        return {
          period,
          rowType: 'product' as const,
          product: String(p.product ?? ''),
          refundOccurrences: Number(p.refundOccurrences ?? 0),
          unitsRefunded: Number(p.unitsRefunded ?? 0),
        };
      });

  return [
    ...summaries.reverse(), // ascending chronological order
    ...toProducts('current', results[0]!),
    ...toProducts('previous', results[1]!),
  ];
}

/**
 * Fulfillment metrics: order fulfillment status and delays
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult, isoDate } from '../helpers.js';
import { queryUnfulfilledOrders, INVENTORY_PAGE_SIZE, MAX_INVENTORY_PAGES } from '../queries.js';

export type FulfillmentSummaryInput = {
  since?: string | null;
};

export async function getFulfillmentSummary(
  conn: ShopifyConnectInfo,
  input: FulfillmentSummaryInput,
): Promise<RecordResult> {
  const since =
    input.since ?? isoDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const queryString = `fulfillment_status:unfulfilled created_at:>=${since}`;

  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  let page = 0;
  let truncated = false;
  const now = Date.now();

  while (page < MAX_INVENTORY_PAGES) {
    const data = await queryUnfulfilledOrders(conn, INVENTORY_PAGE_SIZE, queryString, cursor);

    for (const { node } of data.orders.edges) {
      const created = new Date(node.createdAt);
      const daysOld = Math.floor((now - created.getTime()) / (1000 * 60 * 60 * 24));
      rows.push({
        orderNumber: node.name,
        createdAt: node.createdAt,
        daysUnfulfilled: daysOld,
        fulfillmentStatus: node.displayFulfillmentStatus ?? 'UNFULFILLED',
        items: node.lineItems.edges.map((e) => `${e.node.quantity}× ${e.node.title}`).join('; '),
        shippingCity: node.shippingAddress?.city ?? null,
        shippingCountry: node.shippingAddress?.country ?? null,
      });
    }

    page++;
    if (!data.orders.pageInfo.hasNextPage) break;
    if (page >= MAX_INVENTORY_PAGES) { truncated = true; break; }
    cursor = data.orders.pageInfo.endCursor;
    if (!cursor) break;
  }

  rows.sort((a, b) => (b.daysUnfulfilled as number) - (a.daysUnfulfilled as number));
  return rowsToResult(rows, truncated);
}

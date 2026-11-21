/**
 * Inventory metrics: stock levels and status
 */

import type { ShopifyConnectInfo } from '../credentials.js';
import type { RecordResult } from '../types.js';
import { rowsToResult } from '../helpers.js';
import { queryInventoryItems, MAX_INVENTORY_PAGES, INVENTORY_PAGE_SIZE } from '../queries.js';

export type InventoryLevelsInput = {
  lowStockThreshold?: number;
};

export async function getInventoryLevels(
  conn: ShopifyConnectInfo,
  input: InventoryLevelsInput,
): Promise<RecordResult> {
  const threshold = input.lowStockThreshold ?? 10;

  const rows: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  let page = 0;
  let truncated = false;

  while (page < MAX_INVENTORY_PAGES) {
    const data = await queryInventoryItems(conn, INVENTORY_PAGE_SIZE, cursor);

    for (const edge of data.inventoryItems.edges) {
      const item = edge.node;
      if (!item.variant) continue;

      for (const lvlEdge of item.inventoryLevels.edges) {
        const lvl = lvlEdge.node;
        const available = lvl.quantities.find((q) => q.name === 'available')?.quantity ?? 0;
        const onHand = lvl.quantities.find((q) => q.name === 'on_hand')?.quantity ?? 0;

        rows.push({
          product: item.variant.product.title,
          variant: item.variant.displayName,
          sku: item.sku ?? null,
          location: lvl.location.name,
          available,
          onHand,
          status: available <= 0 ? 'OUT_OF_STOCK' : available < threshold ? 'LOW_STOCK' : 'OK',
        });
      }
    }

    page++;
    if (!data.inventoryItems.pageInfo.hasNextPage) break;
    if (page >= MAX_INVENTORY_PAGES) { truncated = true; break; }
    cursor = data.inventoryItems.pageInfo.endCursor;
    if (!cursor) break;
  }

  rows.sort((a, b) => {
    const order: Record<string, number> = { OUT_OF_STOCK: 0, LOW_STOCK: 1, OK: 2 };
    return (order[a.status as string] ?? 2) - (order[b.status as string] ?? 2);
  });

  return rowsToResult(rows, truncated);
}

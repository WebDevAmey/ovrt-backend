import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { shopifyGraphQL } from '../../../agents/shopify/graphql.js';
import { CHECKOUT_LOSS_QUERY } from '../../../revenue-loss/checkout.js';
import type { ShopifyConnectInfo } from '../../../agents/shopify/credentials.js';

export { resolveShopifySource };

export type ProductWeekSnapshot = {
  product: string;
  windowEnd: string;
  checkoutsContaining: number;
  abandonedContaining: number;
};

// 6 non-overlapping 7-day windows. ewmaProportionControl needs real history
// per product to size its control limit by how many checkouts actually
// contained that product each week.
const SNAPSHOT_COUNT = 6;
const WINDOW_DAYS = 7;
const MAX_PAGES_PER_WINDOW = 15; // bound per-window pagination cost

type CheckoutNode = {
  completedAt: string | null;
  lineItems: { edges: { node: { title: string } }[] };
};
type CheckoutLossQueryResult = {
  abandonedCheckouts: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: CheckoutNode }[];
  };
};

async function fetchWeekSnapshot(
  conn: ShopifyConnectInfo,
  windowStart: string,
  windowEnd: string,
): Promise<ProductWeekSnapshot[]> {
  const queryStr = `created_at:>=${windowStart} AND created_at:<=${windowEnd}`;
  let cursor: string | null = null;
  let hasNextPage = true;
  let pages = 0;

  const totalByProduct = new Map<string, number>();
  const abandonedByProduct = new Map<string, number>();

  while (hasNextPage && pages < MAX_PAGES_PER_WINDOW) {
    const response: CheckoutLossQueryResult = await shopifyGraphQL(conn, CHECKOUT_LOSS_QUERY, {
      query: queryStr,
      cursor,
    });
    const data = response.abandonedCheckouts;

    for (const { node } of data.edges) {
      const isAbandoned = node.completedAt === null;
      // Dedupe per checkout so multiple units/variants of the same product
      // in one cart only count once toward "checkouts containing".
      const productsInCheckout = new Set(node.lineItems.edges.map((e) => e.node.title));
      for (const product of productsInCheckout) {
        totalByProduct.set(product, (totalByProduct.get(product) ?? 0) + 1);
        if (isAbandoned) {
          abandonedByProduct.set(product, (abandonedByProduct.get(product) ?? 0) + 1);
        }
      }
    }

    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
    pages++;
  }

  return Array.from(totalByProduct.entries()).map(([product, total]) => ({
    product,
    windowEnd,
    checkoutsContaining: total,
    abandonedContaining: abandonedByProduct.get(product) ?? 0,
  }));
}

export async function fetchAbandonedCheckoutProducts(
  integrationId: string,
): Promise<ProductWeekSnapshot[]> {
  const conn = await getShopifyConn(integrationId);

  const offsets = Array.from({ length: SNAPSHOT_COUNT }, (_, i) => i * WINDOW_DAYS);
  const snapshots = await Promise.all(
    offsets.map((offset) =>
      fetchWeekSnapshot(conn, daysAgoStr(WINDOW_DAYS + offset), daysAgoStr(1 + offset)),
    ),
  );

  return snapshots.flat();
}

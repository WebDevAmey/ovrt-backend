import { shopifyGraphQL } from '../agents/shopify/graphql.js';
import { type ShopifyConnectInfo } from '../agents/shopify/credentials.js';

export const CHECKOUT_LOSS_QUERY = `
  query abandonedCheckouts($query: String!, $cursor: String) {
    abandonedCheckouts(first: 250, query: $query, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          createdAt
          completedAt
          totalPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 100) {
            edges {
              node {
                title
                variantTitle
                quantity
                variant {
                  id
                  price
                  product {
                    id
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Hard cap on pages fetched so a store with a huge abandoned-checkout history
// (or an over-wide date window) can't pull unbounded data into memory / the
// response. 250 rows/page → 40 pages = 10k checkouts, more than enough for any
// analytics window; beyond that the result is truncated.
const MAX_PAGES = 40;

// Cap on the per-checkout `details` array returned to the caller. The summary,
// recovered summary, and hotspots are aggregates over ALL fetched checkouts;
// `details` is only the most-recent slice so the response payload stays bounded
// even when thousands of checkouts match the window.
const MAX_DETAILS = 500;

export type CheckoutFilter = {
  startDate: string;
  endDate: string;
};

// Shape of the GraphQL response we consume. Only the fields the query selects.
type CheckoutNode = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  totalPriceSet: {
    presentmentMoney: { amount: string; currencyCode: string };
  };
  lineItems: {
    edges: {
      node: {
        title: string;
        variantTitle: string | null;
        quantity: number;
        variant: {
          id: string | null;
          price: string | null;
          product: { id: string | null } | null;
        } | null;
      };
    }[];
  };
};

type CheckoutLossQueryResult = {
  abandonedCheckouts: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: CheckoutNode }[];
  };
};

export type AbandonedCheckoutDetail = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  totalAmount: number;
  currencyCode: string;
  isRecovered: boolean;
  items: {
    title: string;
    variantTitle: string | null;
    quantity: number;
    variantId: string | null;
    productId: string | null;
    unitPrice: number;
  }[];
};

// Per-currency money totals. Lost and recovered values are tracked separately
// per currency so a multi-currency store never sums e.g. USD + EUR into one
// meaningless number.
//
// IMPORTANT: `totalValueLost` here is POTENTIAL (uncaptured) revenue — the gross
// cart value the buyer never paid. It is NOT realized, irrecoverable loss the way
// the refund module's numbers are (you never incurred COGS/fees on an abandoned
// cart). Do not sum checkout `totalValueLost` with refund loss into one figure;
// they are different kinds of loss. The field name and `lossType` below make this
// explicit for the caller.
export type CurrencyTotals = {
  currencyCode: string;
  totalValueLost: number;
  lostCount: number;
  totalValueRecovered: number;
  recoveredCount: number;
};

export type CheckoutLossResult = {
  // Distinguishes this module's output from realized refund loss. Callers/UI
  // should label abandoned-checkout value as "potential revenue not captured".
  lossType: 'potential-uncaptured-revenue';
  // Aggregate counts across all currencies (counts are currency-agnostic).
  summary: {
    totalCount: number;
  };
  recoveredSummary: {
    totalCount: number;
  };
  // Money totals broken down per currency. Most stores have a single entry.
  byCurrency: CurrencyTotals[];
  hotspots: {
    variantId: string | null;
    productId: string | null;
    title: string;
    variantTitle: string | null;
    lostValue: number;
    count: number;
  }[];
  // Most-recent slice of per-checkout detail, capped at MAX_DETAILS. When the
  // matched set exceeds the cap, detailsTruncated is true and details holds the
  // newest MAX_DETAILS checkouts (summary/byCurrency still reflect all of them).
  details: AbandonedCheckoutDetail[];
  detailsTruncated: boolean;
};

export async function calculateCheckoutLoss(
  conn: ShopifyConnectInfo,
  filter: CheckoutFilter
): Promise<CheckoutLossResult> {
  const queryStr = `created_at:>=${filter.startDate} AND created_at:<=${filter.endDate}`;
  let hasNextPage = true;
  let cursor: string | null = null;
  const allCheckouts: CheckoutNode[] = [];
  let pages = 0;

  while (hasNextPage && pages < MAX_PAGES) {
    const response: CheckoutLossQueryResult = await shopifyGraphQL(conn, CHECKOUT_LOSS_QUERY, {
      query: queryStr,
      cursor,
    });

    const data = response.abandonedCheckouts;
    allCheckouts.push(...data.edges.map((edge) => edge.node));
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
    pages++;
  }

  let recoveredCount = 0;
  let lostCount = 0;

  // Per-currency money totals, keyed by currency code, so mixed-currency stores
  // never sum across currencies. A `completedAt` timestamp means the buyer came
  // back and finished the checkout (recovered); null means it stayed lost.
  const currencyMap = new Map<string, CurrencyTotals>();
  const getCurrencyTotals = (code: string): CurrencyTotals => {
    let entry = currencyMap.get(code);
    if (!entry) {
      entry = { currencyCode: code, totalValueLost: 0, lostCount: 0, totalValueRecovered: 0, recoveredCount: 0 };
      currencyMap.set(code, entry);
    }
    return entry;
  };

  const hotspotMap = new Map<string, { title: string; variantTitle: string | null; productId: string | null; lostValue: number; count: number }>();
  const details: AbandonedCheckoutDetail[] = [];

  for (const checkout of allCheckouts) {
    // Guard against null/blank amounts — an unguarded NaN here would poison the
    // running totals (NaN + anything = NaN) and zero out the whole summary.
    const parsedAmount = parseFloat(checkout.totalPriceSet?.presentmentMoney?.amount ?? '');
    const amount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
    const isRecovered = checkout.completedAt !== null;
    const currencyCode = checkout.totalPriceSet?.presentmentMoney?.currencyCode ?? 'UNKNOWN';
    const totals = getCurrencyTotals(currencyCode);

    if (isRecovered) {
      totals.totalValueRecovered += amount;
      totals.recoveredCount++;
      recoveredCount++;
    } else {
      totals.totalValueLost += amount;
      totals.lostCount++;
      lostCount++;
    }

    const items = checkout.lineItems.edges.map((edge) => {
      const node = edge.node;
      const variantId = node.variant?.id || null;
      const productId = node.variant?.product?.id || null;
      const parsedUnitPrice = parseFloat(node.variant?.price ?? '');
      const unitPrice = Number.isFinite(parsedUnitPrice) ? parsedUnitPrice : 0;
      
      if (variantId && !isRecovered) {
        const existing = hotspotMap.get(variantId);
        if (existing) {
          existing.lostValue += unitPrice * node.quantity;
          existing.count += node.quantity;
        } else {
          hotspotMap.set(variantId, {
            title: node.title,
            variantTitle: node.variantTitle,
            productId,
            lostValue: unitPrice * node.quantity,
            count: node.quantity,
          });
        }
      }

      return {
        title: node.title,
        variantTitle: node.variantTitle,
        quantity: node.quantity,
        variantId,
        productId,
        unitPrice,
      };
    });

    details.push({
      id: checkout.id,
      createdAt: checkout.createdAt,
      completedAt: checkout.completedAt,
      totalAmount: amount,
      currencyCode,
      isRecovered,
      items,
    });
  }

  const hotspots = Array.from(hotspotMap.entries())
    .map(([variantId, data]) => ({
      variantId,
      ...data,
    }))
    .sort((a, b) => b.lostValue - a.lostValue);

  const detailsTruncated = details.length > MAX_DETAILS;
  // Newest-first, then cap — so the returned slice is the most-recent checkouts
  // regardless of the order the API paginated them in. Aggregates above already
  // cover the full set.
  const sortedDetails = [...details].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return {
    lossType: 'potential-uncaptured-revenue',
    summary: {
      totalCount: lostCount,
    },
    recoveredSummary: {
      totalCount: recoveredCount,
    },
    byCurrency: Array.from(currencyMap.values()).sort(
      (a, b) => b.totalValueLost - a.totalValueLost
    ),
    hotspots,
    details: detailsTruncated ? sortedDetails.slice(0, MAX_DETAILS) : sortedDetails,
    detailsTruncated,
  };
}

// Local stand-in for Shopify's Admin GraphQL API, used only when
// SHOPIFY_MOCK_GRAPHQL_URL is set (see agents/shopify/graphql.ts). Lets
// revenue-loss (checkout/refund), shopify-data (product-sales, catalog,
// customers, abandoned-checkouts), and anything else that calls
// shopifyGraphQL() return realistic data for a demo store that isn't a real,
// connected Shopify shop. Never used in production — only active when the
// env var is explicitly set.
//
// Run with: npx tsx src/dev/mock-shopify-server.ts

import { createServer } from 'node:http';

const PORT = Number(process.env.SHOPIFY_MOCK_PORT) || 8091;

function moneySet(amount: number, currencyCode = 'USD') {
  const money = { amount: amount.toFixed(2), currencyCode };
  return { shopMoney: money, presentmentMoney: money };
}

function daysAgoIso(n: number, hour = 10): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ── Canned catalog ──────────────────────────────────────────────────────
const PRODUCTS = [
  { id: 'gid://shopify/Product/1001', variantId: 'gid://shopify/ProductVariant/2001', title: 'Vitamin C Serum 30ml', vendor: 'Luma Skincare', productType: 'Serum', price: 55.0, inventory: 182 },
  { id: 'gid://shopify/Product/1002', variantId: 'gid://shopify/ProductVariant/2002', title: 'Gentle Clay Mask', vendor: 'Luma Skincare', productType: 'Mask', price: 44.0, inventory: 1200 },
  { id: 'gid://shopify/Product/1003', variantId: 'gid://shopify/ProductVariant/2003', title: 'Retinol Night Serum 30ml', vendor: 'Luma Skincare', productType: 'Serum', price: 70.0, inventory: 95 },
  { id: 'gid://shopify/Product/1004', variantId: 'gid://shopify/ProductVariant/2004', title: 'Hydrating Toner 150ml', vendor: 'Luma Skincare', productType: 'Toner', price: 34.0, inventory: 310 },
  { id: 'gid://shopify/Product/1005', variantId: 'gid://shopify/ProductVariant/2005', title: 'Travel Set (3-piece)', vendor: 'Luma Skincare', productType: 'Bundle', price: 70.0, inventory: 140 },
];

// ── Canned orders (used by product-sales + refund loss) ────────────────
type CannedOrder = {
  id: string;
  name: string;
  createdAt: string;
  total: number;
  lines: { productIdx: number; quantity: number }[];
  gatewayFee: number;
  shipping: number;
  refund?: { createdAt: string; amount: number; restocked: boolean; lineIdx: number };
};

const ORDERS: CannedOrder[] = Array.from({ length: 24 }, (_, i) => {
  const daysAgo = 1 + Math.floor((i * 33) / 24); // spread over ~35 days
  const lineCount = 1 + (i % 3);
  const lines = Array.from({ length: lineCount }, (_, j) => ({
    productIdx: (i + j) % PRODUCTS.length,
    quantity: 1 + ((i + j) % 2),
  }));
  const total = lines.reduce((sum, l) => sum + PRODUCTS[l.productIdx].price * l.quantity, 0);
  const gatewayFee = Math.round((total * 0.029 + 0.3) * 100) / 100;
  const shipping = 6.5;
  const hasRefund = i % 5 === 0; // ~1 in 5 orders refunded
  return {
    id: `gid://shopify/Order/${5000 + i}`,
    name: `#${10001 + i}`,
    createdAt: daysAgoIso(daysAgo),
    total,
    lines,
    gatewayFee,
    shipping,
    refund: hasRefund
      ? {
          createdAt: daysAgoIso(Math.max(0, daysAgo - 1)),
          amount: Math.round(PRODUCTS[lines[0].productIdx].price * lines[0].quantity * 100) / 100,
          restocked: i % 10 !== 0, // most restock; a couple don't
          lineIdx: 0,
        }
      : undefined,
  };
});

// ── Canned abandoned checkouts (checkout loss + shopify-data) ──────────
type CannedCheckout = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  total: number;
  productIdx: number;
  quantity: number;
};

const CHECKOUTS: CannedCheckout[] = Array.from({ length: 18 }, (_, i) => {
  const daysAgo = 1 + Math.floor((i * 29) / 18);
  const productIdx = i % PRODUCTS.length;
  const quantity = 1 + (i % 2);
  const total = PRODUCTS[productIdx].price * quantity;
  const recovered = i % 4 === 0; // ~1 in 4 recovered
  return {
    id: `gid://shopify/Checkout/${7000 + i}`,
    createdAt: daysAgoIso(daysAgo, 14),
    completedAt: recovered ? daysAgoIso(Math.max(0, daysAgo - 1), 16) : null,
    total,
    productIdx,
    quantity,
  };
});

// ── Canned customers ──────────────────────────────────────────────────
const CUSTOMERS = Array.from({ length: 16 }, (_, i) => {
  const daysAgo = 2 + i * 6;
  const orders = 1 + (i % 5);
  const spent = orders * (35 + (i % 4) * 10);
  return {
    id: `gid://shopify/Customer/${9000 + i}`,
    numberOfOrders: orders,
    amountSpent: spent,
    createdAt: daysAgoIso(daysAgo),
  };
});

// ── Date-range parsing (so checkout-loss, which trusts the server-side
// filter completely, doesn't return checkouts outside the requested window) ──
function parseCreatedAtRange(q: string | null | undefined): { start: Date; end: Date } | null {
  if (!q) return null;
  const m = q.match(/created_at:>=([^\s]+)\s+AND\s+created_at:<=([^\s]+)/);
  if (!m) return null;
  const start = new Date(m[1]);
  const end = new Date(m[2]);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

function pageInfo() {
  return { hasNextPage: false, endCursor: null };
}

function handleOperation(operationName: string | null, variables: Record<string, unknown>): unknown {
  const q = typeof variables.q === 'string' ? variables.q : typeof variables.query === 'string' ? variables.query : null;
  const range = parseCreatedAtRange(q);

  switch (operationName) {
    // revenue-loss/checkout.ts — CHECKOUT_LOSS_QUERY (presentmentMoney, lineItems)
    case 'abandonedCheckouts': {
      const checkouts = range
        ? CHECKOUTS.filter((c) => new Date(c.createdAt) >= range.start && new Date(c.createdAt) <= range.end)
        : CHECKOUTS;
      return {
        abandonedCheckouts: {
          pageInfo: pageInfo(),
          edges: checkouts.map((c) => ({
            node: {
              id: c.id,
              createdAt: c.createdAt,
              completedAt: c.completedAt,
              totalPriceSet: moneySet(c.total),
              lineItems: {
                edges: [
                  {
                    node: {
                      title: PRODUCTS[c.productIdx].title,
                      variantTitle: null,
                      quantity: c.quantity,
                      variant: {
                        id: PRODUCTS[c.productIdx].variantId,
                        price: PRODUCTS[c.productIdx].price.toFixed(2),
                        product: { id: PRODUCTS[c.productIdx].id },
                      },
                    },
                  },
                ],
              },
            },
          })),
        },
      };
    }

    // shopify-data/routes.ts — queries.ts "AbandonedCheckouts" (shopMoney only)
    case 'AbandonedCheckouts': {
      const checkouts = range
        ? CHECKOUTS.filter((c) => new Date(c.createdAt) >= range.start && new Date(c.createdAt) <= range.end)
        : CHECKOUTS;
      return {
        abandonedCheckouts: {
          pageInfo: pageInfo(),
          edges: checkouts.map((c) => ({
            cursor: c.id,
            node: {
              id: c.id,
              createdAt: c.createdAt,
              totalPriceSet: moneySet(c.total),
            },
          })),
        },
      };
    }

    // revenue-loss/refund.ts — GetRefundsInRange
    case 'GetRefundsInRange': {
      return {
        orders: {
          pageInfo: pageInfo(),
          nodes: ORDERS.map((o) => ({
            id: o.id,
            name: o.name,
            currencyCode: 'USD',
            totalShippingPriceSet: moneySet(o.shipping),
            transactions: [
              { kind: 'SALE', status: 'SUCCESS', fees: [{ amount: { amount: o.gatewayFee.toFixed(2), currencyCode: 'USD' } }] },
            ],
            refunds: o.refund
              ? [
                  {
                    id: `gid://shopify/Refund/${o.id.split('/').pop()}`,
                    createdAt: o.refund.createdAt,
                    totalRefundedSet: moneySet(o.refund.amount),
                    orderAdjustments: { nodes: [] },
                    refundLineItems: {
                      nodes: [
                        {
                          quantity: o.lines[o.refund.lineIdx].quantity,
                          restockType: o.refund.restocked ? 'RETURN' : 'NO_RESTOCK',
                          restocked: o.refund.restocked,
                          subtotalSet: moneySet(o.refund.amount),
                          lineItem: {
                            title: PRODUCTS[o.lines[o.refund.lineIdx].productIdx].title,
                            variant: {
                              id: PRODUCTS[o.lines[o.refund.lineIdx].productIdx].variantId,
                              price: PRODUCTS[o.lines[o.refund.lineIdx].productIdx].price.toFixed(2),
                            },
                          },
                        },
                      ],
                    },
                  },
                ]
              : [],
          })),
        },
      };
    }

    // shopify-data/routes.ts — queries.ts "OrdersForProductSales"
    case 'OrdersForProductSales': {
      return {
        orders: {
          pageInfo: pageInfo(),
          edges: ORDERS.map((o) => ({
            cursor: o.id,
            node: {
              id: o.id,
              createdAt: o.createdAt,
              currentTotalPriceSet: moneySet(o.total),
              lineItems: {
                edges: o.lines.map((l) => ({
                  node: {
                    title: PRODUCTS[l.productIdx].title,
                    quantity: l.quantity,
                    variant: { id: PRODUCTS[l.productIdx].variantId, product: { id: PRODUCTS[l.productIdx].id } },
                    originalUnitPriceSet: { shopMoney: { amount: PRODUCTS[l.productIdx].price.toFixed(2) } },
                  },
                })),
              },
              refunds: o.refund ? [{ totalRefundedSet: { shopMoney: { amount: o.refund.amount.toFixed(2) } } }] : [],
            },
          })),
        },
      };
    }

    // shopify-data/routes.ts — queries.ts "Products" (catalog)
    case 'Products': {
      return {
        products: {
          edges: PRODUCTS.map((p) => ({
            node: {
              id: p.id,
              title: p.title,
              handle: p.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
              vendor: p.vendor,
              productType: p.productType,
              status: 'ACTIVE',
              totalInventory: p.inventory,
              createdAt: daysAgoIso(120),
              updatedAt: daysAgoIso(2),
              priceRangeV2: {
                minVariantPrice: { amount: p.price.toFixed(2), currencyCode: 'USD' },
                maxVariantPrice: { amount: p.price.toFixed(2) },
              },
              variants: {
                edges: [{ node: { id: p.variantId, title: 'Default', sku: p.id.split('/').pop(), inventoryQuantity: p.inventory } }],
              },
            },
          })),
        },
      };
    }

    // queries.ts "CustomerRetention" (shopify-data/customers)
    case 'CustomerRetention': {
      return {
        customers: {
          pageInfo: pageInfo(),
          edges: CUSTOMERS.map((c) => ({
            cursor: c.id,
            node: {
              id: c.id,
              numberOfOrders: String(c.numberOfOrders),
              amountSpent: { amount: c.amountSpent.toFixed(2), currencyCode: 'USD' },
              createdAt: c.createdAt,
            },
          })),
        },
      };
    }

    case 'ShopOverview': {
      return {
        shop: {
          name: 'Luma Skincare',
          email: 'hello@lumaskincare.com',
          myshopifyDomain: 'luma-skincare-demo.myshopify.com',
          primaryDomain: { url: 'https://lumaskincare.com' },
          currencyCode: 'USD',
          ianaTimezone: 'America/Los_Angeles',
          plan: { displayName: 'Shopify Plus' },
          billingAddress: { country: 'United States' },
        },
        productsCount: { count: PRODUCTS.length },
        ordersCount: { count: ORDERS.length },
        customersCount: { count: CUSTOMERS.length },
      };
    }

    default: {
      // Unknown operation (something we haven't modeled): return an empty but
      // correctly-shaped connection for whichever root field the query selects,
      // so callers see "no results" instead of crashing on a missing field.
      const emptyConnection = { pageInfo: pageInfo(), edges: [] };
      return {
        orders: emptyConnection,
        products: emptyConnection,
        customers: emptyConnection,
        abandonedCheckouts: emptyConnection,
        inventoryItems: emptyConnection,
      };
    }
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}') as { query?: string; variables?: Record<string, unknown> };
      const match = (parsed.query ?? '').match(/\b(?:query|mutation)\s+(\w+)/);
      const operationName = match ? match[1] : null;
      const data = handleOperation(operationName, parsed.variables ?? {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
      console.log(`[mock-shopify] ${operationName ?? '(unnamed)'} -> 200`);
    } catch (err) {
      console.error('[mock-shopify] request failed', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'mock-shopify-server error' }] }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[mock-shopify] listening on :${PORT}`);
});

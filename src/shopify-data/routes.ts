import { Hono } from 'hono';
import { verifyServiceToken, type ServicePayload } from '../service-token.js';
import { prisma } from '../prisma.js';
import { buildShopifyConnection, SHOPIFY_CONNECTION_SELECT } from '../agents/shopify/credentials.js';
import {
  queryOrdersForProductSales,
  queryProducts,
  queryCustomersWithRetention,
  queryAbandonedCheckouts,
} from '../agents/shopify/queries.js';

const PAGE_SIZE = 250;

export const shopifyData = new Hono<{
  Variables: {
    jwtPayload: ServicePayload;
  };
}>();

// Authentication Middleware
shopifyData.use('*', async (c, next) => {
  const token = c.req.header('x-service-token');
  if (!token) {
    return c.json({ error: 'Missing service token' }, 401);
  }

  const payload = verifyServiceToken(token);
  if (!payload || payload.purpose !== 'shopify-data') {
    return c.json({ error: 'Invalid or unauthorized service token' }, 401);
  }

  c.set('jwtPayload', payload);
  await next();
});

// POST /shopify-data/product-sales
// Returns aggregated sales data by product within a date range
shopifyData.post('/product-sales', async (c) => {
  const payload = c.get('jwtPayload');
  const orgId = payload.orgId;

  try {
    const body = await c.req.json();
    const { startDate, endDate } = body;

    if (!startDate || !endDate) {
      return c.json({ error: 'startDate and endDate are required' }, 400);
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return c.json({ error: 'startDate and endDate must be valid date strings' }, 400);
    }
    if (start.getTime() > end.getTime()) {
      return c.json({ error: 'startDate must be on or before endDate' }, 400);
    }

    // Single DB read: select exactly the columns needed to build the connection,
    // then build it in-process. Avoids the second round-trip that calling
    // resolveShopifyConnection(integration.id) would incur.
    const integration = await prisma.shopifyIntegration.findFirst({
      where: {
        organisationId: orgId,
        status: 'ACTIVE',
      },
      select: SHOPIFY_CONNECTION_SELECT,
    });

    if (!integration) {
      return c.json({ error: 'No active Shopify integration found for this organization' }, 404);
    }

    const conn = buildShopifyConnection(integration);

    // Aggregate sales data by product with pagination
    const productMap = new Map<string, {
      shopifyProductId: string;
      unitsSold: number;
      orderCount: number;
      revenue: number;
    }>();

    let hasMore = true;
    let cursor: string | null = null;
    // Date-range filter is invariant across pages — build once.
    const query = `created_at:>=${startDate} AND created_at:<=${endDate}`;

    while (hasMore) {
      const response = await queryOrdersForProductSales(conn, PAGE_SIZE, query, cursor);

      for (const edge of response.orders.edges) {
        const order = edge.node;
        const orderDate = new Date(order.createdAt);

        // Skip if order is outside the date range
        if (orderDate.getTime() < start.getTime() || orderDate.getTime() > end.getTime()) {
          continue;
        }

        // Total refunded on this order (distributed proportionally across its
        // line items below to produce net-of-refunds product revenue).
        const refundedAmount = order.refunds.reduce(
          (sum, refund) => sum + parseFloat(refund.totalRefundedSet.shopMoney.amount),
          0,
        );

        // Track which products appear in this order (for orderCount)
        const productsInOrder = new Map<string, number>(); // productId -> lineRevenue

        // First pass: calculate line-item revenue and identify products
        for (const lineEdge of order.lineItems.edges) {
          const lineItem = lineEdge.node;
          const productId = lineItem.variant?.product?.id;

          if (!productId) {
            continue;
          }

          const unitPrice = parseFloat(lineItem.originalUnitPriceSet?.shopMoney?.amount || '0');
          const lineRevenue = unitPrice * lineItem.quantity;
          const current = productsInOrder.get(productId) || 0;
          productsInOrder.set(productId, current + lineRevenue);
        }

        // Calculate total line revenue and refund proportion per product
        const totalLineRevenue = Array.from(productsInOrder.values()).reduce((a, b) => a + b, 0);
        const refundProportion = totalLineRevenue > 0 ? refundedAmount / totalLineRevenue : 0;

        // Second pass: aggregate to productMap with net revenue
        for (const lineEdge of order.lineItems.edges) {
          const lineItem = lineEdge.node;
          const productId = lineItem.variant?.product?.id;

          if (!productId) {
            continue;
          }

          const unitPrice = parseFloat(lineItem.originalUnitPriceSet?.shopMoney?.amount || '0');
          const lineRevenue = unitPrice * lineItem.quantity;
          const proportionalRefund = lineRevenue * refundProportion;
          const netLineRevenue = lineRevenue - proportionalRefund;

          if (!productMap.has(productId)) {
            productMap.set(productId, {
              shopifyProductId: productId,
              unitsSold: 0,
              orderCount: 0,
              revenue: 0,
            });
          }

          const existing = productMap.get(productId)!;
          existing.unitsSold += lineItem.quantity;
          existing.revenue += netLineRevenue;
        }

        // Increment orderCount for each product in this order
        for (const productId of productsInOrder.keys()) {
          const existing = productMap.get(productId)!;
          existing.orderCount += 1;
        }
      }

      hasMore = response.orders.pageInfo.hasNextPage;
      cursor = response.orders.pageInfo.endCursor;
    }

    const result = Array.from(productMap.values());
    return c.json(result);
  } catch (err) {
    console.error('[shopify-data/product-sales] calculation failed', err);

    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    return c.json({
      error: 'An internal error occurred while fetching product sales data',
    }, 500);
  }
});

// POST /shopify-data/catalog
// Returns complete product catalog
shopifyData.post('/catalog', async (c) => {
  const payload = c.get('jwtPayload');
  const orgId = payload.orgId;

  try {
    // Single DB read: select exactly the columns needed to build the connection,
    // then build it in-process. Avoids the second round-trip that calling
    // resolveShopifyConnection(integration.id) would incur.
    const integration = await prisma.shopifyIntegration.findFirst({
      where: {
        organisationId: orgId,
        status: 'ACTIVE',
      },
      select: SHOPIFY_CONNECTION_SELECT,
    });

    if (!integration) {
      return c.json({ error: 'No active Shopify integration found for this organization' }, 404);
    }

    const conn = buildShopifyConnection(integration);

    const response = await queryProducts(conn, 250, null);

    const products = response.products.edges.map((edge) => ({
      shopifyProductId: edge.node.id,
      title: edge.node.title,
      vendor: edge.node.vendor || null,
      productType: edge.node.productType || null,
    }));

    return c.json(products);
  } catch (err) {
    console.error('[shopify-data/catalog] failed', err);

    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    return c.json({
      error: 'An internal error occurred while fetching product catalog',
    }, 500);
  }
});

// ── Customers caching ────────────────────────────────────────────────────────
// The customers endpoint paginates over the store's entire customer base via
// cursor pagination, which is inherently sequential (~5s for large stores). The
// underlying data — per-customer order count and lifetime value — changes slowly,
// so we cache the fully-crawled result per (org, date-range) for a short TTL.
//
// The cache stores the in-flight Promise, which gives us two wins at once:
//   1. Repeat dashboard loads within the TTL are served instantly.
//   2. Concurrent identical requests (e.g. the dashboard firing all endpoints at
//      once, or a double-click) share a single crawl instead of each starting
//      their own.
// Rejected crawls are evicted immediately so a transient Shopify failure is never
// cached. The returned data (array + field shape) is byte-for-byte identical to
// the uncached path — only freshness is bounded by the TTL.

type CustomerRow = {
  customerId: string;
  orderCount: number;
  lifetimeValue: number;
  createdAt: string;
};

// Thrown by the crawl when the org has no active Shopify integration. Mapped to
// 404 by the handler; never cached (it rejects the promise).
class NoActiveIntegrationError extends Error {}

const CUSTOMERS_CACHE_TTL_MS = Number(process.env.SHOPIFY_CUSTOMERS_CACHE_TTL_MS) || 5 * 60 * 1000;
const CUSTOMERS_CACHE_MAX_ENTRIES = 50;

type CustomersCacheEntry = { expiresAt: number; data: Promise<CustomerRow[]> };
const customersCache = new Map<string, CustomersCacheEntry>();

async function crawlCustomers(
  orgId: string,
  startDate: string | undefined,
  endDate: string | undefined,
): Promise<CustomerRow[]> {
  // Single DB read: select exactly the columns needed to build the connection,
  // then build it in-process. Avoids the second round-trip that calling
  // resolveShopifyConnection(integration.id) would incur.
  const integration = await prisma.shopifyIntegration.findFirst({
    where: {
      organisationId: orgId,
      status: 'ACTIVE',
    },
    select: SHOPIFY_CONNECTION_SELECT,
  });

  if (!integration) {
    throw new NoActiveIntegrationError();
  }

  const conn = buildShopifyConnection(integration);

  const customers: CustomerRow[] = [];
  let hasMore = true;
  let cursor: string | null = null;
  // If date range provided, filter to customers created in that range. Invariant
  // across pages — build once.
  const query = startDate && endDate ? `created_at:>=${startDate} AND created_at:<=${endDate}` : null;

  while (hasMore) {
    const response = await queryCustomersWithRetention(conn, PAGE_SIZE, cursor, query);

    for (const edge of response.customers.edges) {
      const node = edge.node;
      customers.push({
        customerId: node.id,
        orderCount: parseInt(node.numberOfOrders, 10),
        lifetimeValue: parseFloat(node.amountSpent.amount),
        createdAt: node.createdAt,
      });
    }

    hasMore = response.customers.pageInfo.hasNextPage;
    cursor = response.customers.pageInfo.endCursor;
  }

  return customers;
}

function getCustomers(
  orgId: string,
  startDate: string | undefined,
  endDate: string | undefined,
): Promise<CustomerRow[]> {
  const key = `${orgId}|${startDate ?? ''}|${endDate ?? ''}`;
  const now = Date.now();

  const cached = customersCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  // Drop expired entries; if still at capacity (many distinct date ranges), clear
  // the lot rather than let the map grow unbounded. Entries are large (one object
  // per customer), so we keep the cap conservative.
  if (customersCache.size >= CUSTOMERS_CACHE_MAX_ENTRIES) {
    for (const [k, v] of customersCache) {
      if (v.expiresAt <= now) customersCache.delete(k);
    }
    if (customersCache.size >= CUSTOMERS_CACHE_MAX_ENTRIES) {
      customersCache.clear();
    }
  }

  const data = crawlCustomers(orgId, startDate, endDate);
  customersCache.set(key, { expiresAt: now + CUSTOMERS_CACHE_TTL_MS, data });

  // Never serve a rejected crawl from cache — evict on failure so the next call
  // retries. Guard against clobbering a newer entry under the same key.
  data.catch(() => {
    const cur = customersCache.get(key);
    if (cur && cur.data === data) customersCache.delete(key);
  });

  return data;
}

// POST /shopify-data/customers
// Returns customer retention data with order counts and lifetime values
shopifyData.post('/customers', async (c) => {
  const payload = c.get('jwtPayload');
  const orgId = payload.orgId;

  try {
    const body = await c.req.json() as Record<string, unknown>;
    const startDate = body.startDate as string | undefined;
    const endDate = body.endDate as string | undefined;

    const customers = await getCustomers(orgId, startDate, endDate);

    return c.json(customers);
  } catch (err) {
    if (err instanceof NoActiveIntegrationError) {
      return c.json({ error: 'No active Shopify integration found for this organization' }, 404);
    }

    console.error('[shopify-data/customers] failed', err);

    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    return c.json({
      error: 'An internal error occurred while fetching customer data',
    }, 500);
  }
});

// POST /shopify-data/abandoned-checkouts
// Returns abandoned checkout count and total value in date range
shopifyData.post('/abandoned-checkouts', async (c) => {
  const payload = c.get('jwtPayload');
  const orgId = payload.orgId;

  try {
    const body = await c.req.json();
    const { startDate, endDate } = body;

    if (!startDate || !endDate) {
      return c.json({ error: 'startDate and endDate are required' }, 400);
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return c.json({ error: 'startDate and endDate must be valid date strings' }, 400);
    }
    if (start.getTime() > end.getTime()) {
      return c.json({ error: 'startDate must be on or before endDate' }, 400);
    }

    // Single DB read: select exactly the columns needed to build the connection,
    // then build it in-process. Avoids the second round-trip that calling
    // resolveShopifyConnection(integration.id) would incur.
    const integration = await prisma.shopifyIntegration.findFirst({
      where: {
        organisationId: orgId,
        status: 'ACTIVE',
      },
      select: SHOPIFY_CONNECTION_SELECT,
    });

    if (!integration) {
      return c.json({ error: 'No active Shopify integration found for this organization' }, 404);
    }

    const conn = buildShopifyConnection(integration);

    let totalCount = 0;
    let totalValue = 0;
    let hasMore = true;
    let cursor: string | null = null;
    // Date-range filter is invariant across pages — build once.
    const query = `created_at:>=${startDate} AND created_at:<=${endDate}`;

    while (hasMore) {
      const response = await queryAbandonedCheckouts(conn, PAGE_SIZE, query, cursor);

      for (const edge of response.abandonedCheckouts.edges) {
        const checkout = edge.node;
        totalCount += 1;
        totalValue += parseFloat(checkout.totalPriceSet.shopMoney.amount);
      }

      hasMore = response.abandonedCheckouts.pageInfo.hasNextPage;
      cursor = response.abandonedCheckouts.pageInfo.endCursor;
    }

    return c.json({
      count: totalCount,
      totalValue: totalValue,
    });
  } catch (err) {
    console.error('[shopify-data/abandoned-checkouts] failed', err);

    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    return c.json({
      error: 'An internal error occurred while fetching abandoned checkout data',
    }, 500);
  }
});

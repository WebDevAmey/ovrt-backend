/**
 * Shared types for Shopify GraphQL responses and function inputs
 */

export type RecordResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated?: boolean;
};

// ── Order aggregation types ──────────────────────────────────────────────────

export type OrderPageNode = {
  id: string;
  createdAt: string;
  displayFinancialStatus?: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  totalDiscountsSet?: { shopMoney: { amount: string } } | null;
  customer?: { id: string; state?: string | null } | null;
  shippingAddress?: { city?: string | null; country?: string | null } | null;
  lineItems?: {
    edges: Array<{
      node: {
        title: string;
        quantity: number;
        originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
      };
    }>;
  };
};

export type OrderPageResponse = {
  orders: {
    edges: Array<{ cursor: string; node: OrderPageNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Product sales order response ─────────────────────────────────────────────

export type ProductSalesOrderNode = {
  id: string;
  createdAt: string;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: {
    edges: Array<{
      node: {
        title: string;
        quantity: number;
        variant?: { id: string; product?: { id: string } } | null;
        originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
      };
    }>;
  };
  refunds: Array<{
    totalRefundedSet: { shopMoney: { amount: string } };
  }>;
};

export type ProductSalesOrdersResponse = {
  orders: {
    edges: Array<{ cursor: string; node: ProductSalesOrderNode }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Shop overview ────────────────────────────────────────────────────────────

export type ShopOverviewResponse = {
  shop: {
    name: string;
    email?: string | null;
    myshopifyDomain: string;
    primaryDomain?: { url?: string | null } | null;
    currencyCode: string;
    ianaTimezone?: string | null;
    plan?: { displayName?: string | null } | null;
    billingAddress?: { country?: string | null } | null;
  };
  productsCount?: { count: number } | null;
  ordersCount?: { count: number } | null;
  customersCount?: { count: number } | null;
};

// ── Orders listing ──────────────────────────────────────────────────────────

export type OrdersResponse = {
  orders: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        createdAt: string;
        processedAt?: string | null;
        displayFinancialStatus?: string | null;
        displayFulfillmentStatus?: string | null;
        currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        subtotalPriceSet?: { shopMoney: { amount: string } } | null;
        totalDiscountsSet?: { shopMoney: { amount: string } } | null;
        customer?: { id: string; email?: string | null; displayName?: string | null } | null;
        lineItems: { edges: Array<{ node: { title: string; quantity: number } }> };
      };
    }>;
  };
};

// ── Products ─────────────────────────────────────────────────────────────────

export type ProductsResponse = {
  products: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        handle: string;
        vendor?: string | null;
        productType?: string | null;
        status: string;
        totalInventory?: number | null;
        createdAt: string;
        updatedAt: string;
        priceRangeV2: {
          minVariantPrice: { amount: string; currencyCode: string };
          maxVariantPrice: { amount: string };
        };
        variants: {
          edges: Array<{
            node: { id: string; title?: string | null; sku?: string | null; inventoryQuantity?: number | null };
          }>;
        };
      };
    }>;
  };
};

// ── Inventory ────────────────────────────────────────────────────────────────

export type InventoryItemsResponse = {
  inventoryItems: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        sku: string | null;
        tracked: boolean;
        variant: {
          displayName: string;
          product: { title: string };
        } | null;
        inventoryLevels: {
          edges: Array<{
            node: {
              quantities: Array<{ name: string; quantity: number }>;
              location: { id: string; name: string };
            };
          }>;
        };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Customer retention ───────────────────────────────────────────────────────

export type CustomerRetentionPageResponse = {
  customers: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        numberOfOrders: string;
        amountSpent: { amount: string; currencyCode: string };
        createdAt: string;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Discount performance ─────────────────────────────────────────────────────

export type OrderWithDiscountsResponse = {
  orders: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        createdAt: string;
        currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        totalDiscountsSet: { shopMoney: { amount: string } } | null;
        discountCodes: string[];
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Fulfillment ──────────────────────────────────────────────────────────────

export type UnfulfilledOrdersResponse = {
  orders: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        name: string;
        createdAt: string;
        displayFulfillmentStatus: string | null;
        lineItems: { edges: Array<{ node: { title: string; quantity: number } }> };
        shippingAddress: { city?: string | null; country?: string | null } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Refunds ──────────────────────────────────────────────────────────────────

export type OrderWithRefundsPageResponse = {
  orders: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
        refunds: Array<{
          totalRefundedSet: { shopMoney: { amount: string } };
          refundLineItems: {
            edges: Array<{
              node: {
                lineItem: { title: string } | null;
                quantity: number;
              };
            }>;
          };
        }>;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Checkout abandonment ─────────────────────────────────────────────────────

export type AbandonedCheckoutsResponse = {
  abandonedCheckouts: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        createdAt: string;
        totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

// ── Customers ────────────────────────────────────────────────────────────────

export type CustomersResponse = {
  customers: {
    edges: Array<{
      node: {
        id: string;
        email?: string | null;
        displayName?: string | null;
        createdAt: string;
        numberOfOrders: string;
        amountSpent: { amount: string; currencyCode: string };
        state: string;
        defaultAddress?: { country?: string | null; city?: string | null } | null;
        lastOrder?: { id: string; name: string; createdAt: string } | null;
      };
    }>;
  };
};

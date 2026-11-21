/**
 * Shopify GraphQL query definitions
 * Each query is paired with its response type for easy discovery
 */

import { shopifyGraphQL } from './graphql.js';
import type { ShopifyConnectInfo } from './credentials.js';
import type {
  ShopOverviewResponse,
  OrdersResponse,
  ProductsResponse,
  InventoryItemsResponse,
  CustomerRetentionPageResponse,
  OrderWithDiscountsResponse,
  UnfulfilledOrdersResponse,
  OrderWithRefundsPageResponse,
  AbandonedCheckoutsResponse,
  CustomersResponse,
  ProductSalesOrdersResponse,
} from './types.js';

const INVENTORY_PAGE_SIZE = 250;
const MAX_INVENTORY_PAGES = 5; // 1,250 variants max
const MAX_CUSTOMER_PAGES = 8;

export async function queryShopOverview(conn: ShopifyConnectInfo): Promise<ShopOverviewResponse> {
  const query = /* GraphQL */ `
    query ShopOverview {
      shop {
        name
        email
        myshopifyDomain
        primaryDomain { url }
        currencyCode
        ianaTimezone
        plan { displayName }
        billingAddress { country }
      }
      productsCount { count }
      ordersCount { count }
      customersCount { count }
    }
  `;
  return shopifyGraphQL<ShopOverviewResponse>(conn, query);
}

export async function queryOrders(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
): Promise<OrdersResponse> {
  const query = /* GraphQL */ `
    query Orders($first: Int!, $q: String) {
      orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            processedAt
            displayFinancialStatus
            displayFulfillmentStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            subtotalPriceSet { shopMoney { amount } }
            totalDiscountsSet { shopMoney { amount } }
            customer { id email displayName }
            lineItems(first: 5) { edges { node { title quantity } } }
          }
        }
      }
    }
  `;
  return shopifyGraphQL<OrdersResponse>(conn, query, {
    first,
    q,
  });
}

export async function queryProducts(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
): Promise<ProductsResponse> {
  const query = /* GraphQL */ `
    query Products($first: Int!, $q: String) {
      products(first: $first, query: $q, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            title
            handle
            vendor
            productType
            status
            totalInventory
            createdAt
            updatedAt
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
              maxVariantPrice { amount }
            }
            variants(first: 50) { edges { node { id title sku inventoryQuantity } } }
          }
        }
      }
    }
  `;
  return shopifyGraphQL<ProductsResponse>(conn, query, {
    first,
    q,
  });
}

export async function queryInventoryItems(
  conn: ShopifyConnectInfo,
  first: number,
  after: string | null,
): Promise<InventoryItemsResponse> {
  const query = /* GraphQL */ `
    query InventoryItems($first: Int!, $after: String) {
      inventoryItems(first: $first, after: $after, query: "tracked:true") {
        edges {
          cursor
          node {
            id
            sku
            tracked
            variant {
              displayName
              product { title }
            }
            inventoryLevels(first: 10) {
              edges {
                node {
                  quantities(names: ["available", "on_hand"]) { name quantity }
                  location { id name }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  return shopifyGraphQL<InventoryItemsResponse>(conn, query, {
    first,
    after,
  });
}

export async function queryCustomersWithRetention(
  conn: ShopifyConnectInfo,
  first: number,
  after: string | null,
  q: string | null,
): Promise<CustomerRetentionPageResponse> {
  const gql = /* GraphQL */ `
    query CustomerRetention($first: Int!, $after: String, $q: String) {
      customers(first: $first, after: $after, query: $q, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            id
            numberOfOrders
            amountSpent { amount currencyCode }
            createdAt
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  return shopifyGraphQL<CustomerRetentionPageResponse>(conn, gql, {
    first,
    after,
    q,
  });
}

export async function queryOrdersWithDiscounts(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
  after: string | null,
): Promise<OrderWithDiscountsResponse> {
  const gql = /* GraphQL */ `
    query OrdersWithDiscounts($first: Int!, $q: String, $after: String) {
      orders(first: $first, query: $q, after: $after, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            id
            createdAt
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            totalDiscountsSet { shopMoney { amount } }
            discountCodes
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  return shopifyGraphQL<OrderWithDiscountsResponse>(conn, gql, {
    first,
    q,
    after,
  });
}

export async function queryUnfulfilledOrders(
  conn: ShopifyConnectInfo,
  first: number,
  q: string,
  after: string | null,
): Promise<UnfulfilledOrdersResponse> {
  const gql = /* GraphQL */ `
    query UnfulfilledOrders($first: Int!, $q: String, $after: String) {
      orders(first: $first, query: $q, after: $after, sortKey: CREATED_AT, reverse: false) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            displayFulfillmentStatus
            lineItems(first: 5) { edges { node { title quantity } } }
            shippingAddress { city country }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  return shopifyGraphQL<UnfulfilledOrdersResponse>(conn, gql, {
    first,
    q,
    after,
  });
}

export async function queryOrdersWithRefunds(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
  after: string | null,
): Promise<OrderWithRefundsPageResponse> {
  const gql = /* GraphQL */ `
    query OrdersWithRefunds($first: Int!, $q: String, $after: String) {
      orders(first: $first, query: $q, after: $after, sortKey: CREATED_AT) {
        edges {
          cursor
          node {
            id
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            refunds {
              totalRefundedSet { shopMoney { amount } }
              refundLineItems(first: 10) {
                edges {
                  node {
                    lineItem { title }
                    quantity
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  return shopifyGraphQL<OrderWithRefundsPageResponse>(conn, gql, {
    first,
    q,
    after,
  });
}

export async function queryAbandonedCheckouts(
  conn: ShopifyConnectInfo,
  first: number,
  q: string,
  after: string | null,
): Promise<AbandonedCheckoutsResponse> {
  const checkoutsQuery = /* GraphQL */ `
    query AbandonedCheckouts($first: Int!, $q: String, $after: String) {
      abandonedCheckouts(first: $first, query: $q, after: $after, sortKey: CREATED_AT, reverse: false) {
        edges {
          cursor
          node {
            id
            createdAt
            totalPriceSet { shopMoney { amount currencyCode } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  return shopifyGraphQL<AbandonedCheckoutsResponse>(conn, checkoutsQuery, {
    first,
    q,
    after,
  });
}

export async function queryCustomers(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
): Promise<CustomersResponse> {
  const query = /* GraphQL */ `
    query Customers($first: Int!, $q: String) {
      customers(first: $first, query: $q, sortKey: UPDATED_AT, reverse: true) {
        edges {
          node {
            id
            email
            displayName
            createdAt
            numberOfOrders
            amountSpent { amount currencyCode }
            state
            defaultAddress { country city }
            lastOrder { id name createdAt }
          }
        }
      }
    }
  `;
  return shopifyGraphQL<CustomersResponse>(conn, query, {
    first,
    q,
  });
}

export async function queryOrdersForProductSales(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
  after: string | null,
): Promise<ProductSalesOrdersResponse> {
  const gql = /* GraphQL */ `
    query OrdersForProductSales($first: Int!, $q: String, $after: String) {
      orders(first: $first, query: $q, after: $after, sortKey: CREATED_AT, reverse: true) {
        edges {
          cursor
          node {
            id
            createdAt
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            lineItems(first: 250) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    id
                    product { id }
                  }
                  originalUnitPriceSet { shopMoney { amount } }
                }
              }
            }
            refunds {
              totalRefundedSet { shopMoney { amount } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  return shopifyGraphQL<ProductSalesOrdersResponse>(conn, gql, {
    first,
    q,
    after,
  });
}

export { INVENTORY_PAGE_SIZE, MAX_INVENTORY_PAGES, MAX_CUSTOMER_PAGES };

export const DEFAULT_LIST_LIMIT_EXPORT = 25;
export const MAX_LIST_LIMIT_EXPORT = 100;

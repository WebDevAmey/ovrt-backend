/**
 * Shopify read queries for the support agent
 * ===========================================
 * Extra read-only queries the customer-support tools need beyond the analytics
 * agent's set: order fulfillments/tracking, the store's published policies, and
 * discount-code validity. All go through the shared read transport
 * (`shopifyGraphQL`), which rejects mutations — these are strictly read-only.
 *
 * Kept here (alongside queries.ts) rather than in src/support so the GraphQL +
 * connection types live with the rest of the Shopify Admin API layer.
 */

import { shopifyGraphQL } from './graphql.js';
import type { ShopifyConnectInfo } from './credentials.js';

export type OrderFulfillmentNode = {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  customer: { email: string | null; displayName: string | null } | null;
  fulfillments: Array<{
    displayStatus: string | null;
    estimatedDeliveryAt: string | null;
    trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }>;
  }>;
};

export type OrderFulfillmentsResponse = {
  orders: { edges: Array<{ node: OrderFulfillmentNode }> };
};

/** Orders matching `q` (newest first) with their fulfillment + tracking detail. */
export async function queryOrdersWithFulfillments(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
): Promise<OrderFulfillmentsResponse> {
  const query = /* GraphQL */ `
    query OrderTracking($first: Int!, $q: String) {
      orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            processedAt
            displayFinancialStatus
            displayFulfillmentStatus
            customer { email displayName }
            fulfillments(first: 10) {
              displayStatus
              estimatedDeliveryAt
              trackingInfo(first: 5) { number url company }
            }
          }
        }
      }
    }
  `;
  return shopifyGraphQL<OrderFulfillmentsResponse>(conn, query, { first, q });
}

export type OrderForActionNode = {
  id: string;
  name: string;
  createdAt: string;
  displayFulfillmentStatus: string | null;
  customer: { email: string | null } | null;
  lineItems: { edges: Array<{ node: { quantity: number; variant: { id: string } | null } }> };
};

export type OrdersForActionResponse = {
  orders: { edges: Array<{ node: OrderForActionNode }> };
};

/** Orders matching `q` with the fields the write-action executors need (variant ids for reorder). */
export async function queryOrdersForAction(
  conn: ShopifyConnectInfo,
  first: number,
  q: string | null,
): Promise<OrdersForActionResponse> {
  const query = /* GraphQL */ `
    query OrdersForAction($first: Int!, $q: String) {
      orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            createdAt
            displayFulfillmentStatus
            customer { email }
            lineItems(first: 50) {
              edges { node { quantity variant { id } } }
            }
          }
        }
      }
    }
  `;
  return shopifyGraphQL<OrdersForActionResponse>(conn, query, { first, q });
}

export type ShopPoliciesResponse = {
  shop: { shopPolicies: Array<{ type: string; body: string; url: string | null }> };
};

/** The store's published policies (refund, shipping, returns, privacy, terms). */
export async function queryStorePolicies(conn: ShopifyConnectInfo): Promise<ShopPoliciesResponse> {
  const query = /* GraphQL */ `
    query StorePolicies {
      shop {
        shopPolicies { type body url }
      }
    }
  `;
  return shopifyGraphQL<ShopPoliciesResponse>(conn, query);
}

export type DiscountByCodeResponse = {
  codeDiscountNodeByCode: {
    codeDiscount: {
      __typename: string;
      title?: string | null;
      status?: string | null;
      startsAt?: string | null;
      endsAt?: string | null;
    } | null;
  } | null;
};

/** Look up a discount code's validity/status (read-only). */
export async function queryDiscountByCode(
  conn: ShopifyConnectInfo,
  code: string,
): Promise<DiscountByCodeResponse> {
  const query = /* GraphQL */ `
    query DiscountByCode($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        codeDiscount {
          __typename
          ... on DiscountCodeBasic { title status startsAt endsAt }
          ... on DiscountCodeFreeShipping { title status startsAt endsAt }
          ... on DiscountCodeBxgy { title status startsAt endsAt }
        }
      }
    }
  `;
  return shopifyGraphQL<DiscountByCodeResponse>(conn, query, { code });
}

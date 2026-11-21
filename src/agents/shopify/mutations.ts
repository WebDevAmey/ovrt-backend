/**
 * Shopify mutation transport (support actions ONLY)
 * =================================================
 * A SEPARATE, allow-listed write path. The read transport (graphql.ts) hard-
 * rejects any string containing "mutation"; this module deliberately permits
 * mutations, but ONLY through the small set of typed wrappers below
 * (cancel / address update / reorder). There is no generic "run any mutation"
 * export — callers cannot smuggle arbitrary writes through here.
 *
 * Each wrapper throws ShopifyGraphQLError on transport/GraphQL errors AND on a
 * non-empty `userErrors` array (a business-rule rejection), so the executor's
 * try/catch turns any failure into a safe `failed` outcome → human escalation.
 *
 * NOTE: the exact field shapes (orderCancel async job, OrderInput.shippingAddress,
 * draftOrderCreate.invoiceUrl) are pinned to Admin API 2025-07 and must be
 * verified against a live store as part of rollout.
 */

import { getAdminClient, ShopifyGraphQLError } from './graphql.js';
import type { ShopifyConnectInfo } from './credentials.js';

const DEFAULT_TIMEOUT_MS = 30_000;

type GraphQLErrorEntry = { message: string; path?: Array<string | number> };
type UserError = { field?: string[] | null; message: string; code?: string | null };

async function runMutation<T>(
  conn: ShopifyConnectInfo,
  mutation: string,
  variables: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const client = getAdminClient(conn);
  const requestPromise = client.request<T>(mutation, { variables });
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new ShopifyGraphQLError(`Shopify mutation timed out after ${timeoutMs}ms`, 408)), timeoutMs);
  });

  let response;
  try {
    response = await Promise.race([requestPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof ShopifyGraphQLError) throw err;
    throw new ShopifyGraphQLError(`Shopify mutation failed: ${err instanceof Error ? err.message : String(err)}`, 0);
  }

  if (response.errors) {
    const e = response.errors as { networkStatusCode?: number; message?: string; graphQLErrors?: GraphQLErrorEntry[] };
    const gqlErrors = e.graphQLErrors ?? [];
    const message =
      gqlErrors.length > 0
        ? `Shopify GraphQL error: ${gqlErrors.map((g) => g.message).join('; ')}`
        : `Shopify mutation error: ${e.message ?? 'unknown error'}`;
    throw new ShopifyGraphQLError(message, e.networkStatusCode ?? 0, gqlErrors);
  }
  if (!response.data) throw new ShopifyGraphQLError('Shopify returned no data field', 502);
  return response.data;
}

/** Throw a ShopifyGraphQLError if a mutation's userErrors array has entries. */
function assertNoUserErrors(errors: UserError[] | undefined, op: string): void {
  if (errors && errors.length > 0) {
    throw new ShopifyGraphQLError(`${op} rejected: ${errors.map((u) => u.message).join('; ')}`, 422);
  }
}

export type ShopifyMailingAddressInput = {
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
};

/** Cancel an order (restock, notify the customer; no refund — refunds are a separate gated action). */
export async function orderCancel(
  conn: ShopifyConnectInfo,
  input: { orderId: string; reason?: string; notifyCustomer?: boolean },
): Promise<void> {
  const mutation = /* GraphQL */ `
    mutation SupportOrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean) {
      orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer) {
        job { id }
        orderCancelUserErrors { field message code }
      }
    }
  `;
  const data = await runMutation<{ orderCancel: { orderCancelUserErrors: UserError[] } }>(conn, mutation, {
    orderId: input.orderId,
    reason: input.reason ?? 'CUSTOMER',
    refund: false,
    restock: true,
    notifyCustomer: input.notifyCustomer ?? true,
  });
  assertNoUserErrors(data.orderCancel?.orderCancelUserErrors, 'orderCancel');
}

/** Update an unfulfilled order's shipping address. */
export async function orderUpdateShippingAddress(
  conn: ShopifyConnectInfo,
  input: { orderId: string; address: ShopifyMailingAddressInput },
): Promise<void> {
  const mutation = /* GraphQL */ `
    mutation SupportOrderUpdate($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { field message }
      }
    }
  `;
  const data = await runMutation<{ orderUpdate: { userErrors: UserError[] } }>(conn, mutation, {
    input: { id: input.orderId, shippingAddress: input.address },
  });
  assertNoUserErrors(data.orderUpdate?.userErrors, 'orderUpdate');
}

/** Create a draft order for the same items and return its checkout (invoice) URL. */
export async function draftOrderCreate(
  conn: ShopifyConnectInfo,
  input: { lineItems: Array<{ variantId: string; quantity: number }>; email: string },
): Promise<{ invoiceUrl: string }> {
  const mutation = /* GraphQL */ `
    mutation SupportDraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder { id invoiceUrl }
        userErrors { field message }
      }
    }
  `;
  const data = await runMutation<{
    draftOrderCreate: { draftOrder: { id: string; invoiceUrl: string | null } | null; userErrors: UserError[] };
  }>(conn, mutation, {
    input: {
      email: input.email,
      lineItems: input.lineItems.map((li) => ({ variantId: li.variantId, quantity: li.quantity })),
    },
  });
  assertNoUserErrors(data.draftOrderCreate?.userErrors, 'draftOrderCreate');
  const url = data.draftOrderCreate?.draftOrder?.invoiceUrl;
  if (!url) throw new ShopifyGraphQLError('draftOrderCreate returned no invoiceUrl', 502);
  return { invoiceUrl: url };
}

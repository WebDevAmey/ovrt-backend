/**
 * Shopify GraphQL transport
 * =========================
 * Thin wrapper around `@shopify/admin-api-client` (the official lightweight
 * GraphQL client). The package handles:
 *   - URL + API version assembly
 *   - X-Shopify-Access-Token header
 *   - Retries on 429 / 5xx with rate-limit awareness
 *   - JSON framing
 *
 * We add on top:
 *   - Per-call timeout (admin-api-client doesn't enforce one itself)
 *   - Throw-on-errors so callers don't have to inspect a discriminated union
 *   - Mutation rejection (defence in depth — every query string this agent
 *     produces is read-only by contract, but we double-check before sending)
 */

import { createAdminApiClient, type AdminApiClient } from '@shopify/admin-api-client';
import type { ShopifyConnectInfo } from './credentials.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MUTATION_RE = /\bmutation\b/i;

// admin-api-client wants a sync `customFetchApi` we can plug into. We pass
// the standard global fetch; per-call timeouts are layered above via
// AbortController so the package's retries respect them too.
type GraphQLErrorEntry = {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
};

export class ShopifyGraphQLError extends Error {
  readonly status: number;
  readonly errors: GraphQLErrorEntry[];
  constructor(message: string, status: number, errors: GraphQLErrorEntry[] = []) {
    super(message);
    this.name = 'ShopifyGraphQLError';
    this.status = status;
    this.errors = errors;
  }
}

const clientCache = new Map<string, AdminApiClient>();

/**
 * The cached Admin API client for a connection. Exported so the (separate)
 * mutation transport in mutations.ts can reuse the same connection pool —
 * WITHOUT inheriting this module's read-only mutation guard.
 */
export function getAdminClient(conn: ShopifyConnectInfo): AdminApiClient {
  return getClient(conn);
}

// Dev/demo-only escape hatch: when set, every Shopify Admin API call from
// this process is transparently redirected to a local mock GraphQL server
// instead of the real network (see src/dev/mock-shopify-server.ts). Lets a
// demo store with a fake accessToken exercise revenue-loss, shopify-data,
// and any other live-Shopify feature. Unset in every real deployment, so
// behavior there is unchanged — this only ever adds a fetch override.
const MOCK_GRAPHQL_URL = process.env.SHOPIFY_MOCK_GRAPHQL_URL;

function mockRedirectFetch(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(MOCK_GRAPHQL_URL as string, init);
}

function getClient(conn: ShopifyConnectInfo): AdminApiClient {
  const key = `${conn.shopDomain}|${conn.apiVersion}|${conn.accessToken}`;
  let client = clientCache.get(key);
  if (!client) {
    client = createAdminApiClient({
      storeDomain: conn.shopDomain,
      apiVersion: conn.apiVersion,
      accessToken: conn.accessToken,
      retries: 2,
      ...(MOCK_GRAPHQL_URL ? { customFetchApi: mockRedirectFetch } : {}),
    });
    clientCache.set(key, client);
  }
  return client;
}

/**
 * Sends a read-only GraphQL query against the Shopify Admin API.
 * Throws ShopifyGraphQLError on any failure path so callers can use a single
 * try/catch instead of inspecting a discriminated response.
 */
export async function shopifyGraphQL<T = unknown>(
  conn: ShopifyConnectInfo,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  if (MUTATION_RE.test(query)) {
    throw new ShopifyGraphQLError(
      'Rejected: only read-only queries are permitted from the Shopify agent.',
      400,
    );
  }

  const client = getClient(conn);

  // admin-api-client doesn't take a signal, so we race the request against a
  // timeout promise. The client's own retry logic still runs internally; we
  // just bail out on the outer call if it overruns.
  const requestPromise = client.request<T>(query, { variables });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(new ShopifyGraphQLError(`Shopify request timed out after ${timeoutMs}ms`, 408)),
      timeoutMs,
    );
  });

  let response;
  try {
    response = await Promise.race([requestPromise, timeoutPromise]);
  } catch (err) {
    if (err instanceof ShopifyGraphQLError) throw err;
    throw new ShopifyGraphQLError(
      `Shopify request failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (response.errors) {
    const e = response.errors;
    // ResponseErrors shape: { networkStatusCode?, message?, graphQLErrors?, response? }
    const networkStatus =
      typeof (e as { networkStatusCode?: number }).networkStatusCode === 'number'
        ? (e as { networkStatusCode: number }).networkStatusCode
        : 0;
    const gqlErrors = ((e as { graphQLErrors?: GraphQLErrorEntry[] }).graphQLErrors ?? []) as GraphQLErrorEntry[];
    const baseMessage = (e as { message?: string }).message ?? 'unknown error';
    const message =
      gqlErrors.length > 0
        ? `Shopify GraphQL error: ${gqlErrors.map((g) => g.message).join('; ')}`
        : `Shopify request error: ${baseMessage}`;
    throw new ShopifyGraphQLError(message, networkStatus, gqlErrors);
  }

  if (!response.data) {
    throw new ShopifyGraphQLError('Shopify returned no data field', 502);
  }

  return response.data;
}

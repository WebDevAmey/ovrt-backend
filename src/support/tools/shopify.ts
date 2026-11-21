/**
 * Support agent — Shopify lookup tools (channel-agnostic)
 * =======================================================
 * A deliberately narrow, customer-safe subset of the Shopify agent's tool
 * surface (src/agents/shopify/functions.ts), exposed to the support agent so it
 * can ground replies in real order/product/stock data instead of guessing.
 *
 * SAFETY BY CONSTRUCTION — what's deliberately NOT exposed here:
 *   - getOrdersSummary / getOrdersTimeSeries / getTopProductsBySales
 *     (store-wide revenue, sales totals, AOV — never appropriate in a
 *     customer-facing reply)
 *   - listCustomers, getCustomerRetentionStats (other customers' data)
 *   - getDiscountPerformance, getRefundAnalysis (internal health metrics)
 *   - shopifyRawQuery (unrestricted GraphQL)
 *
 * lookupOrder is scoped to the conversation's own customer email: results are
 * filtered to orders whose customer email matches, so a sender can't probe other
 * customers' orders by guessing order numbers.
 *
 * THE BUG THIS FIXES: the old Gmail version compared/queried using the raw
 * `From` header (`"Jane" <jane@acme.com>`) as if it were a bare email. That
 * malformed every order query and made the email-match filter never match, so
 * every lookup returned zero rows and real orders were reported as "not found".
 * Here the email is already parsed/normalised by the adapter (see
 * support/email-address.ts) before it reaches us.
 *
 * Each tool is exported individually (buildLookupOrderTool / buildLookupProductTool)
 * so intent-tools.ts can hand the agent only the tool(s) its intent needs;
 * buildShopifyTools composes both for the OTHER+directive case.
 */

import { tool } from 'ai';
import { z } from 'zod';
import { listOrders, listProducts } from '../../agents/shopify/functions.js';
import { availabilityFromQty, priceRangeDisplay } from './product-format.js';
import { buildOrderNameClause } from './order-query.js';
import type { StoreContext, ToolEvent } from '../types.js';

/** Shape of a single variant row carried through listProducts' result rows. */
type ProductVariant = {
  title: string | null;
  sku: string | null;
  inventoryQuantity: number | null;
};

const lookupOrderSchema = z.object({
  orderNumber: z
    .string()
    .nullable()
    .optional()
    .describe('Order name/number as the customer wrote it, e.g. "#1234" or "1234". Leading "#" optional.'),
  rationale: z.string().describe('One sentence: what you need this order info for.'),
});

const lookupProductSchema = z.object({
  searchTerm: z
    .string()
    .describe('Product name, keyword, or SKU the customer mentioned, e.g. "blue kurti" or "ABC-123".'),
  rationale: z.string().describe('One sentence: what you need this product info for.'),
});

export type ToolBuildArgs = {
  store: StoreContext;
  onEvent?: (event: ToolEvent) => void;
};

/**
 * lookupOrder — fetch THIS customer's own order(s) by order number, scoped to
 * their email. See module docs for the email-matching rationale.
 */
export function buildLookupOrderTool({ store, onEvent }: ToolBuildArgs) {
  // Already normalised by the adapter. Empty string ⇒ no usable email on file.
  const customerEmail = (store.customerEmail ?? '').trim().toLowerCase();

  return tool({
    description:
      "Look up the customer's own order(s) by order number, e.g. when they ask " +
      '"where is my order #1234" or "what\'s the status of my order". ' +
      "Only returns orders placed with this customer's email address — " +
      'never use this to look up another person\'s order. ' +
      'If orderNumber is omitted, returns this customer\'s most recent orders. ' +
      'If you supply an order number and nothing comes back, the order may have ' +
      'been placed under a different email — ask the customer to confirm (clarify), ' +
      'do NOT tell them it does not exist.',
    inputSchema: lookupOrderSchema,
    execute: async (input) => {
      try {
        if (!customerEmail) {
          onEvent?.({ tool: 'lookupOrder', rationale: input.rationale, error: 'no customer email on conversation' });
          return {
            rowCount: 0,
            rows: [],
            note: 'No email is on file for this customer, so their orders cannot be looked up ' +
              'automatically. Ask the customer to confirm the email used on the order (clarify).',
          };
        }

        // Scope to this customer's email AND (optionally) the order number.
        const queryParts = [`email:${customerEmail}`];
        const nameClause = buildOrderNameClause(input.orderNumber);
        if (nameClause) queryParts.push(nameClause);

        const result = await listOrders(store.conn, { query: queryParts.join(' '), limit: 5 });

        // Defence in depth: drop any row whose customer email doesn't match,
        // comparing PARSED email to PARSED email (the old bug compared a bare
        // order email against a full `"Name" <addr>` header — never equal).
        const rows = result.rows.filter(
          (r) => String(r.customerEmail ?? '').trim().toLowerCase() === customerEmail,
        );

        onEvent?.({ tool: 'lookupOrder', rationale: input.rationale, rowCount: rows.length });

        if (rows.length === 0) {
          // Distinguish "asked for a specific order we couldn't find under this
          // email" (likely a different-email order ⇒ clarify) from "this customer
          // simply has no orders".
          const askedForSpecific = !!nameClause;
          return {
            rowCount: 0,
            rows: [],
            note: askedForSpecific
              ? 'No order with that number is associated with this customer\'s email. It may have ' +
                'been placed under a different email address — do NOT tell the customer it does not ' +
                'exist. Instead, ask them to confirm the email used at checkout or any other detail ' +
                '(clarify).'
              : 'This customer has no orders associated with their email on file. If they expected ' +
                'an order, ask them to confirm the email used at checkout (clarify) — do not assert ' +
                'they have never ordered.',
          };
        }
        return { rowCount: rows.length, rows };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ tool: 'lookupOrder', rationale: input.rationale, error: msg });
        return { error: msg };
      }
    },
  });
}

/**
 * lookupProduct — search the catalog for a product by name, keyword, or SKU.
 */
export function buildLookupProductTool({ store, onEvent }: ToolBuildArgs) {
  return tool({
    description:
      'Search the store catalog for a product by name, keyword, or SKU — e.g. when the ' +
      'customer asks about a product\'s price, availability, or whether it\'s in stock. ' +
      'Returns title, price, status, overall stock, and a per-variant (e.g. per size/colour) ' +
      'in-stock breakdown for each matching product, so you can answer about a specific ' +
      'size or option the customer named.',
    inputSchema: lookupProductSchema,
    execute: async (input) => {
      try {
        const term = input.searchTerm.trim();
        // Search broadly, then narrow only if needed. A BARE multi-word term
        // (e.g. `black wash denim jeans`) lets Shopify tokenise and fuzzy/prefix
        // match across title, SKU, vendor, type, tags — forgiving of how a
        // customer phrases it. A QUOTED phrase ("...") forces an exact-phrase
        // match and frequently returns nothing (the catalog title is rarely the
        // customer's exact wording) — that false "not found" is what led the
        // model to invent a price. So: bare term first.
        let result = await listProducts(store.conn, { query: term || undefined, limit: 5 });

        // Fallback: if the full phrase found nothing, retry on the longest single
        // word (often the head noun, e.g. "jeans") to catch near-misses before
        // giving up and asking the customer.
        if (result.rowCount === 0 && term.includes(' ')) {
          const longestWord = term
            .split(/\s+/)
            .filter((w) => w.length >= 3)
            .sort((a, b) => b.length - a.length)[0];
          if (longestWord && longestWord.toLowerCase() !== term.toLowerCase()) {
            result = await listProducts(store.conn, { query: longestWord, limit: 5 });
          }
        }

        onEvent?.({ tool: 'lookupProduct', rationale: input.rationale, rowCount: result.rowCount });

        if (result.rowCount === 0) {
          return {
            rowCount: 0,
            rows: [],
            note: 'No product matched this search term. This often means the customer used a ' +
              'different name, spelling, or wording than the catalog — NOT that the product does ' +
              'not exist. Try searching again with a different keyword from their message before ' +
              'giving up. Do not guess specs, price, or availability, and do not flatly tell the ' +
              'customer it does not exist; prefer to ask them to confirm the exact product name ' +
              'or share a link (a "clarify" reply).',
          };
        }
        return {
          rowCount: result.rowCount,
          rows: result.rows.map((r) => {
            const variants = ((r.variants as ProductVariant[] | undefined) ?? []).map((v) => ({
              option: v.title,
              sku: v.sku,
              // Three-state, NOT a boolean: a variant with untracked inventory
              // (inventoryQuantity == null) is "unknown", not out-of-stock.
              // Reporting untracked-but-sellable items as out-of-stock was the
              // old bug — many Shopify stores don't track quantities at all.
              availability: availabilityFromQty(v.inventoryQuantity),
            }));
            // Product-level availability: prefer a per-variant rollup (if ANY
            // variant is in stock, the product is). Only fall back to
            // totalInventory when there are no variant rows, and never claim a
            // non-active product (DRAFT/ARCHIVED) is buyable.
            const variantInStock = variants.some((v) => v.availability === 'in_stock');
            const variantKnown = variants.some((v) => v.availability !== 'unknown');
            const availability =
              r.status && r.status !== 'ACTIVE'
                ? 'unavailable'
                : variantKnown
                  ? variantInStock
                    ? 'in_stock'
                    : 'out_of_stock'
                  : availabilityFromQty(r.totalInventory as number | null);
            return {
              title: r.title,
              status: r.status,
              // Pre-formatted price in the SHOP's own currency — quote this
              // verbatim. The bare numeric/code fields are kept for reference
              // but the model must NOT reformat them (it tends to emit "$").
              price: priceRangeDisplay(
                r.minPrice as number | null,
                r.maxPrice as number | null,
                r.currency as string | null,
              ),
              minPrice: r.minPrice,
              maxPrice: r.maxPrice,
              currency: r.currency,
              // Deliberately NOT exposing exact quantities — privacy rules forbid
              // sharing inventory counts beyond simple availability.
              availability,
              variants,
            };
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ tool: 'lookupProduct', rationale: input.rationale, error: msg });
        return { error: msg };
      }
    },
  });
}

export type BuildShopifyToolsArgs = ToolBuildArgs;

/**
 * Build the full read-only Shopify tool set (both lookups). Used for the
 * OTHER+directive case where the agent's intent doesn't pre-determine which
 * tool is relevant.
 */
export function buildShopifyTools(args: BuildShopifyToolsArgs) {
  return {
    lookupOrder: buildLookupOrderTool(args),
    lookupProduct: buildLookupProductTool(args),
  };
}

/**
 * Support agent — extra read-only Shopify tools
 * ==============================================
 * Beyond lookupOrder / lookupProduct (tools/shopify.ts), these ground the agent
 * for the richer playbooks: live tracking, store policies, and discount-code
 * validity. All read-only and, where they touch orders, scoped to THIS
 * customer's email — a sender can never probe another customer's data.
 *
 * Composed into the agent's toolset by buildSupportReadTools (agent.ts spreads
 * it alongside buildShopifyTools).
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  queryOrdersWithFulfillments,
  queryStorePolicies,
  queryDiscountByCode,
} from '../../agents/shopify/support-queries.js';
import { buildOrderNameClause } from './order-query.js';
import { summarizeShipments, describeDiscount } from './tracking-format.js';
import type { StoreContext, ToolEvent } from '../types.js';

export type ReadToolArgs = {
  store: StoreContext;
  onEvent?: (event: ToolEvent) => void;
};

const POLICY_TYPES = ['REFUND_POLICY', 'SHIPPING_POLICY', 'PRIVACY_POLICY', 'TERMS_OF_SERVICE', 'SUBSCRIPTION_POLICY'] as const;

/** Crude HTML→text so a policy body pasted into the prompt stays readable. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * getOrderTracking — the order's fulfillment + tracking detail (number, carrier,
 * link, delivery estimate, delivery status). Scoped to the customer's own email.
 */
export function buildGetOrderTrackingTool({ store, onEvent }: ReadToolArgs) {
  const customerEmail = (store.customerEmail ?? '').trim().toLowerCase();
  return tool({
    description:
      "Get shipping/tracking detail for the customer's own order(s) — tracking number, carrier, " +
      'tracking link, delivery estimate, and delivery status. Use this for "where is my order", ' +
      'late-delivery, and "has it shipped" questions. Optionally pass an order number; omit it for ' +
      'their most recent order. Only returns orders placed with this customer\'s email.',
    inputSchema: z.object({
      orderNumber: z
        .string()
        .nullable()
        .optional()
        .describe('Order name/number as the customer wrote it, e.g. "#1234" or "1234". Leading "#" optional.'),
      rationale: z.string().describe('One sentence: what you need this tracking info for.'),
    }),
    execute: async (input) => {
      try {
        if (!customerEmail) {
          onEvent?.({ tool: 'getOrderTracking', rationale: input.rationale, error: 'no customer email' });
          return {
            rowCount: 0,
            rows: [],
            note: 'No email is on file for this customer, so their orders cannot be looked up. Ask them to ' +
              'confirm the email used at checkout (clarify).',
          };
        }

        const parts = [`email:${customerEmail}`];
        const nameClause = buildOrderNameClause(input.orderNumber);
        if (nameClause) parts.push(nameClause);

        const data = await queryOrdersWithFulfillments(store.conn, 5, parts.join(' '));
        const rows = data.orders.edges
          .map((e) => e.node)
          .filter((n) => String(n.customer?.email ?? '').trim().toLowerCase() === customerEmail)
          .map((n) => ({
            orderNumber: n.name,
            createdAt: n.createdAt,
            fulfillmentStatus: n.displayFulfillmentStatus,
            financialStatus: n.displayFinancialStatus,
            shipments: summarizeShipments(n.fulfillments),
          }));

        onEvent?.({ tool: 'getOrderTracking', rationale: input.rationale, rowCount: rows.length });

        if (rows.length === 0) {
          return {
            rowCount: 0,
            rows: [],
            note: nameClause
              ? 'No order with that number is associated with this customer\'s email — it may be under a ' +
                'different email. Ask them to confirm the checkout email (clarify); do NOT say it does not exist.'
              : 'This customer has no orders on file under their email. Ask them to confirm the email used at ' +
                'checkout (clarify).',
          };
        }
        return { rowCount: rows.length, rows };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ tool: 'getOrderTracking', rationale: input.rationale, error: msg });
        return { error: msg };
      }
    },
  });
}

/**
 * getStorePolicies — the store's published policies (refund / shipping / returns /
 * privacy / terms). Quote/summarise these instead of guessing a policy.
 */
export function buildGetStorePoliciesTool({ store, onEvent }: ReadToolArgs) {
  return tool({
    description:
      "Fetch the store's published policies (refund, shipping, returns, privacy, terms). Use this for " +
      'any question about the store\'s policies — return window, refund rules, shipping/delivery terms — ' +
      'instead of guessing. Optionally filter by policy type.',
    inputSchema: z.object({
      policyType: z
        .enum(POLICY_TYPES)
        .nullable()
        .optional()
        .describe('Limit to one policy type, or omit/null for all of them.'),
      rationale: z.string().describe('One sentence: what policy detail you need.'),
    }),
    execute: async (input) => {
      try {
        const data = await queryStorePolicies(store.conn);
        let policies = data.shop.shopPolicies ?? [];
        if (input.policyType) policies = policies.filter((p) => p.type === input.policyType);

        const rows = policies.map((p) => ({
          type: p.type,
          url: p.url,
          // Bodies are HTML and can be long — strip tags and cap so the prompt stays bounded.
          text: stripHtml(p.body).slice(0, 1500),
        }));

        onEvent?.({ tool: 'getStorePolicies', rationale: input.rationale, rowCount: rows.length });

        if (rows.length === 0) {
          return {
            rowCount: 0,
            rows: [],
            note: 'The store has not published this policy. Use the merchant GENERAL INSTRUCTIONS if they ' +
              'cover it; otherwise say you will confirm the details rather than guessing.',
          };
        }
        return { rowCount: rows.length, rows };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ tool: 'getStorePolicies', rationale: input.rationale, error: msg });
        return { error: msg };
      }
    },
  });
}

/**
 * checkDiscountCode — whether a discount code is valid/active right now. For
 * "my code isn't working" questions; never invent a discount.
 */
export function buildCheckDiscountCodeTool({ store, onEvent }: ReadToolArgs) {
  return tool({
    description:
      'Check whether a discount/promo code is valid and currently active. Use this when a customer says ' +
      'a code is not working or asks if a code is valid. Returns whether it exists and whether it is active ' +
      '(not expired/scheduled). Do NOT invent or offer a code that is not active.',
    inputSchema: z.object({
      code: z.string().describe('The exact discount code the customer typed.'),
      rationale: z.string().describe('One sentence: why you are checking this code.'),
    }),
    execute: async (input) => {
      try {
        const code = input.code.trim();
        if (!code) {
          return { found: false, note: 'No code provided; ask the customer for the exact code.' };
        }
        const data = await queryDiscountByCode(store.conn, code);
        const summary = describeDiscount(data.codeDiscountNodeByCode?.codeDiscount ?? null);

        onEvent?.({ tool: 'checkDiscountCode', rationale: input.rationale, rowCount: summary.found ? 1 : 0 });

        if (!summary.found) {
          return {
            found: false,
            note: `No discount code "${code}" exists on this store. Tell the customer the code isn't ` +
              "recognised and ask them to double-check it; do not invent an alternative.",
          };
        }
        return {
          found: true,
          active: summary.active,
          status: summary.status,
          title: summary.title,
          startsAt: summary.startsAt,
          endsAt: summary.endsAt,
          note: summary.active
            ? 'The code is active. If it is failing at checkout, it may have usage/eligibility conditions ' +
              '(minimum spend, specific products, one-per-customer) — explain gently and offer to help.'
            : `The code is not currently usable (status: ${summary.status ?? 'unknown'}). Explain that kindly.`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onEvent?.({ tool: 'checkDiscountCode', rationale: input.rationale, error: msg });
        return { error: msg };
      }
    },
  });
}

/** Compose the extra read-only support tools. */
export function buildSupportReadTools(args: ReadToolArgs) {
  return {
    getOrderTracking: buildGetOrderTrackingTool(args),
    getStorePolicies: buildGetStorePoliciesTool(args),
    checkDiscountCode: buildCheckDiscountCodeTool(args),
  };
}

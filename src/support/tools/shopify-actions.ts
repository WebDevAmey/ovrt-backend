/**
 * Support agent — gated write-action tools
 * ========================================
 * AI-SDK tools that let the agent actually DO things on Shopify: cancel an
 * order, change an unfulfilled order's address, create a reorder link. Each
 * wraps a pure executor (../actions/executors.ts) which enforces permission,
 * identity, idempotency, eligibility, and the confirmation handshake — the tool
 * is a thin adapter that parses input, runs the executor, and reports the
 * authoritative outcome back to the model (and onto a ToolEvent for the runner).
 *
 * Only tools for PERFORMABLE actions (merchant-enabled ∩ implemented) are
 * included, so the model never sees a tool it isn't allowed to use.
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  executeCancelOrder,
  executeEditAddress,
  executeReorder,
  type ActionEnv,
} from '../actions/executors.js';
import type { ActionType, ActionOutcome } from '../actions/permissions.js';
import type { ToolEvent } from '../types.js';

export type ActionToolArgs = {
  env: ActionEnv;
  performable: ReadonlySet<ActionType>;
  onEvent?: (event: ToolEvent) => void;
};

type OnEvent = ((event: ToolEvent) => void) | undefined;

const orderNumberField = z
  .string()
  .nullable()
  .optional()
  .describe('Order name/number as the customer wrote it, e.g. "#1234" or "1234". Omit for their most recent order.');

const confirmedField = z
  .boolean()
  .describe(
    'Set TRUE only after the customer has explicitly agreed in this conversation to this exact action. ' +
      'Leave FALSE to first recap and ask them to confirm — the tool will tell you to ask.',
  );

const rationaleField = z.string().describe('One sentence: why you are taking this action now.');

/** Status → instruction so the model phrases the reply correctly and never fakes success. */
function noteForStatus(out: ActionOutcome): string {
  switch (out.status) {
    case 'proposed':
      return 'NOT done yet. Recap the specifics and ask the customer to confirm; only call again with confirmed:true once they clearly say yes.';
    case 'executed':
      return 'Done successfully. Tell the customer warmly and clearly what was done.';
    case 'not_permitted':
      return 'You are not allowed to do this. Do NOT claim it is done; explain the next step or escalate per the workflow.';
    case 'ineligible':
      return 'This cannot be done for this order. Do NOT claim it is done; explain why (see summary) and offer the best alternative.';
    case 'failed':
      return 'It FAILED. Do NOT claim success; apologise briefly — a teammate will be brought in.';
  }
}

function toToolResult(out: ActionOutcome) {
  const invoiceUrl = typeof out.detail?.invoiceUrl === 'string' ? out.detail.invoiceUrl : undefined;
  return {
    status: out.status,
    summary: out.summary,
    orderRef: out.orderRef,
    ...(invoiceUrl ? { invoiceUrl } : {}),
    note: noteForStatus(out),
  };
}

function buildCancelTool(env: ActionEnv, onEvent: OnEvent) {
  return tool({
    description:
      "Cancel the customer's own order. Use ONLY after confirming the exact order with them. Unfulfilled " +
      'orders only; an already-shipped order cannot be cancelled (offer a return instead).',
    inputSchema: z.object({
      orderNumber: orderNumberField,
      reason: z.string().nullable().optional().describe('Optional cancel reason; defaults to a customer request.'),
      confirmed: confirmedField,
      rationale: rationaleField,
    }),
    execute: async (input) => {
      const out = await executeCancelOrder(env, {
        orderNumber: input.orderNumber,
        reason: input.reason ?? undefined,
        confirmed: input.confirmed,
      });
      onEvent?.({ tool: 'cancelOrder', rationale: input.rationale, action: out });
      return toToolResult(out);
    },
  });
}

function buildEditAddressTool(env: ActionEnv, onEvent: OnEvent) {
  return tool({
    description:
      "Update the shipping address on the customer's own unfulfilled order. Use ONLY after reading the full " +
      'new address back and confirming it. Cannot change an order that has already shipped.',
    inputSchema: z.object({
      orderNumber: orderNumberField,
      address: z
        .object({
          address1: z.string().nullable().optional(),
          address2: z.string().nullable().optional(),
          city: z.string().nullable().optional(),
          province: z.string().nullable().optional().describe('State/province.'),
          country: z.string().nullable().optional(),
          zip: z.string().nullable().optional().describe('Postal/ZIP code.'),
          phone: z.string().nullable().optional(),
          firstName: z.string().nullable().optional(),
          lastName: z.string().nullable().optional(),
        })
        .describe('The corrected shipping address fields the customer provided.'),
      confirmed: confirmedField,
      rationale: rationaleField,
    }),
    execute: async (input) => {
      const address = Object.fromEntries(
        Object.entries(input.address).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
      );
      const out = await executeEditAddress(env, {
        orderNumber: input.orderNumber,
        address,
        confirmed: input.confirmed,
      });
      onEvent?.({ tool: 'editAddress', rationale: input.rationale, action: out });
      return toToolResult(out);
    },
  });
}

function buildReorderTool(env: ActionEnv, onEvent: OnEvent) {
  return tool({
    description:
      'Create a reorder checkout link for the same items as a past order (it charges nothing — just a fresh ' +
      'checkout the customer can complete). Share the returned invoiceUrl with them.',
    inputSchema: z.object({
      orderNumber: orderNumberField,
      confirmed: z.boolean().optional().describe('Not required for reorder (it only creates a link).'),
      rationale: rationaleField,
    }),
    execute: async (input) => {
      const out = await executeReorder(env, { orderNumber: input.orderNumber, confirmed: input.confirmed ?? true });
      onEvent?.({ tool: 'reorder', rationale: input.rationale, action: out });
      return toToolResult(out);
    },
  });
}

/** Build the action tools the agent is permitted and wired to use. */
export function buildSupportActionTools({ env, performable, onEvent }: ActionToolArgs) {
  return {
    ...(performable.has('cancelOrder') ? { cancelOrder: buildCancelTool(env, onEvent) } : {}),
    ...(performable.has('editAddress') ? { editAddress: buildEditAddressTool(env, onEvent) } : {}),
    ...(performable.has('reorder') ? { reorder: buildReorderTool(env, onEvent) } : {}),
  };
}

/**
 * Write-action executors (pure logic, injected I/O)
 * =================================================
 * The single place that decides whether and how a customer-requested write
 * action runs against Shopify. Every executor enforces, in order:
 *   1. PERMISSION  — the merchant toggle must be on (else `not_permitted`).
 *   2. IDENTITY    — the order must belong to THIS customer's email (else `ineligible`).
 *   3. IDEMPOTENCY — an already-executed action (same conversation+order) is a no-op.
 *   4. ELIGIBILITY — guardrails (unfulfilled-only, cancellation window…).
 *   5. CONFIRMATION— irreversible actions need an explicit in-thread "yes" first.
 *   6. EXECUTE     — run the mutation, log the outcome (executed/failed).
 *
 * All Shopify and persistence I/O is INJECTED (ActionOps / ActionLog) so the
 * decision logic above is fully unit-testable without a live store or DB. The
 * real implementations live in src/agents/shopify/mutations.ts and a thin
 * prisma-backed ActionLog (action-log.ts).
 */

import type { ActionType, ActionStatus, ActionOutcome, ActionPolicy } from './permissions.js';

export type ActionOrder = {
  /** Shopify order GID (stable id used for the mutation + idempotency log). */
  id: string;
  /** Human order name shown to the customer, e.g. "#1001". */
  name: string;
  email: string | null;
  /** Order displayFulfillmentStatus: UNFULFILLED, PARTIALLY_FULFILLED, FULFILLED, … */
  fulfillmentStatus: string | null;
  createdAt: string;
  lineItems: Array<{ variantId: string | null; quantity: number }>;
};

export type ShippingAddressInput = {
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

/** The Shopify operations the executors depend on (real impls in mutations.ts). */
export type ActionOps = {
  /** Find an order owned by `customerEmail` (scoped), by number or most recent. */
  findOrder(input: { orderNumber?: string | null; customerEmail: string }): Promise<ActionOrder | null>;
  cancelOrder(input: { orderId: string; reason: string; notifyCustomer: boolean }): Promise<void>;
  updateShippingAddress(input: { orderId: string; address: ShippingAddressInput }): Promise<void>;
  createReorder(input: { lineItems: Array<{ variantId: string; quantity: number }>; email: string }): Promise<{ invoiceUrl: string }>;
};

/** Audit + idempotency store (real impl is prisma-backed SupportActionLog). */
export type ActionLog = {
  hasExecuted(input: { conversationId: string; orderRef: string; actionType: ActionType }): Promise<boolean>;
  record(input: {
    organisationId: string;
    conversationId: string;
    orderRef: string | null;
    actionType: ActionType;
    status: ActionStatus;
    detail: Record<string, unknown>;
  }): Promise<void>;
};

export type ActionEnv = {
  organisationId: string;
  conversationId: string;
  customerEmail: string | null;
  policy: ActionPolicy;
  ops: ActionOps;
  log: ActionLog;
  /** Injectable clock for the cancellation-window guardrail (defaults to Date.now). */
  now?: () => Date;
};

function outcome(
  type: ActionType,
  orderRef: string | null,
  status: ActionStatus,
  summary: string,
  detail?: Record<string, unknown>,
): ActionOutcome {
  return { type, orderRef, status, summary, ...(detail ? { detail } : {}) };
}

/** Persist only real outcomes (executed/failed) — those are the audit + idempotency rows. */
async function record(
  env: ActionEnv,
  type: ActionType,
  orderRefForLog: string | null,
  status: Extract<ActionStatus, 'executed' | 'failed'>,
  detail: Record<string, unknown>,
): Promise<void> {
  await env.log.record({
    organisationId: env.organisationId,
    conversationId: env.conversationId,
    orderRef: orderRefForLog,
    actionType: type,
    status,
    detail,
  });
}

function isUnfulfilled(status: string | null): boolean {
  return status === null || status === 'UNFULFILLED';
}

function hoursSince(iso: string, now?: () => Date): number {
  const then = new Date(iso).getTime();
  const current = (now ? now() : new Date()).getTime();
  return (current - then) / 3_600_000;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function executeCancelOrder(
  env: ActionEnv,
  input: { orderNumber?: string | null; reason?: string; confirmed: boolean },
): Promise<ActionOutcome> {
  const type: ActionType = 'cancelOrder';
  if (!env.policy.cancelOrder.enabled) {
    return outcome(type, input.orderNumber ?? null, 'not_permitted', 'Cancelling orders is not enabled for this store.');
  }
  if (!env.customerEmail) {
    return outcome(type, null, 'ineligible', 'No email on file to verify the order before cancelling.');
  }
  const order = await env.ops.findOrder({ orderNumber: input.orderNumber, customerEmail: env.customerEmail });
  if (!order) {
    return outcome(type, input.orderNumber ?? null, 'ineligible', 'No matching order under this customer email.');
  }
  if (await env.log.hasExecuted({ conversationId: env.conversationId, orderRef: order.id, actionType: type })) {
    return outcome(type, order.name, 'executed', `Order ${order.name} was already cancelled.`);
  }
  if (env.policy.cancelOrder.onlyIfUnfulfilled && !isUnfulfilled(order.fulfillmentStatus)) {
    return outcome(type, order.name, 'ineligible', `Order ${order.name} is already fulfilled/shipped and cannot be cancelled — offer a return.`);
  }
  const maxH = env.policy.cancelOrder.maxHoursAfterOrder;
  if (maxH != null && hoursSince(order.createdAt, env.now) > maxH) {
    return outcome(type, order.name, 'ineligible', `Order ${order.name} is past the ${maxH}h cancellation window.`);
  }
  if (env.policy.requireCustomerConfirmation && !input.confirmed) {
    return outcome(type, order.name, 'proposed', `Recap order ${order.name} and ask the customer to confirm before cancelling.`);
  }
  try {
    await env.ops.cancelOrder({ orderId: order.id, reason: input.reason ?? 'CUSTOMER', notifyCustomer: true });
    await record(env, type, order.id, 'executed', {});
    return outcome(type, order.name, 'executed', `Order ${order.name} has been cancelled.`);
  } catch (err) {
    const msg = errMsg(err);
    await record(env, type, order.id, 'failed', { error: msg });
    return outcome(type, order.name, 'failed', `Cancelling order ${order.name} failed: ${msg}`);
  }
}

export async function executeEditAddress(
  env: ActionEnv,
  input: { orderNumber?: string | null; address: ShippingAddressInput; confirmed: boolean },
): Promise<ActionOutcome> {
  const type: ActionType = 'editAddress';
  if (!env.policy.editAddress.enabled) {
    return outcome(type, input.orderNumber ?? null, 'not_permitted', 'Editing order addresses is not enabled for this store.');
  }
  if (!env.customerEmail) {
    return outcome(type, null, 'ineligible', 'No email on file to verify the order before editing it.');
  }
  const order = await env.ops.findOrder({ orderNumber: input.orderNumber, customerEmail: env.customerEmail });
  if (!order) {
    return outcome(type, input.orderNumber ?? null, 'ineligible', 'No matching order under this customer email.');
  }
  if (env.policy.editAddress.onlyIfUnfulfilled && !isUnfulfilled(order.fulfillmentStatus)) {
    return outcome(type, order.name, 'ineligible', `Order ${order.name} has already shipped; its address can no longer be changed.`);
  }
  if (env.policy.requireCustomerConfirmation && !input.confirmed) {
    return outcome(type, order.name, 'proposed', `Read the new address back to the customer and confirm before updating order ${order.name}.`);
  }
  try {
    await env.ops.updateShippingAddress({ orderId: order.id, address: input.address });
    await record(env, type, order.id, 'executed', { address: input.address });
    return outcome(type, order.name, 'executed', `The shipping address on order ${order.name} has been updated.`);
  } catch (err) {
    const msg = errMsg(err);
    await record(env, type, order.id, 'failed', { error: msg });
    return outcome(type, order.name, 'failed', `Updating the address on order ${order.name} failed: ${msg}`);
  }
}

export async function executeReorder(
  env: ActionEnv,
  input: { orderNumber?: string | null; confirmed: boolean },
): Promise<ActionOutcome> {
  const type: ActionType = 'reorder';
  if (!env.policy.reorder.enabled) {
    return outcome(type, input.orderNumber ?? null, 'not_permitted', 'Reordering is not enabled for this store.');
  }
  if (!env.customerEmail) {
    return outcome(type, null, 'ineligible', 'No email on file to find the previous order to reorder.');
  }
  const order = await env.ops.findOrder({ orderNumber: input.orderNumber, customerEmail: env.customerEmail });
  if (!order) {
    return outcome(type, input.orderNumber ?? null, 'ineligible', 'No matching order under this customer email to reorder.');
  }
  const lineItems = order.lineItems
    .filter((li): li is { variantId: string; quantity: number } => !!li.variantId)
    .map((li) => ({ variantId: li.variantId, quantity: li.quantity }));
  if (lineItems.length === 0) {
    return outcome(type, order.name, 'ineligible', `No reorderable items found on order ${order.name}.`);
  }
  // Reorder only creates a fresh checkout link — it charges nothing and changes
  // nothing the customer owns, so it never needs the confirmation handshake.
  try {
    const { invoiceUrl } = await env.ops.createReorder({ lineItems, email: env.customerEmail });
    await record(env, type, order.id, 'executed', { invoiceUrl });
    return outcome(type, order.name, 'executed', `A reorder checkout link was created for ${order.name}.`, { invoiceUrl });
  } catch (err) {
    const msg = errMsg(err);
    await record(env, type, order.id, 'failed', { error: msg });
    return outcome(type, order.name, 'failed', `Creating a reorder link for ${order.name} failed: ${msg}`);
  }
}

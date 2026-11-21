import { describe, it, expect, vi } from 'vitest';
import { executeCancelOrder, executeReorder, executeEditAddress, type ActionEnv, type ActionOrder, type ActionOps, type ActionLog } from './executors.js';
import { DEFAULT_ACTION_POLICY, parseActionPolicy, type ActionPolicy } from './permissions.js';

const ORDER: ActionOrder = {
  id: 'gid://shopify/Order/1',
  name: '#1001',
  email: 'jane@acme.com',
  fulfillmentStatus: 'UNFULFILLED',
  createdAt: '2026-06-25T10:00:00Z',
  lineItems: [{ variantId: 'gid://shopify/ProductVariant/9', quantity: 2 }],
};

function fakeOps(over: Partial<ActionOps> = {}): ActionOps {
  return {
    findOrder: vi.fn(async () => ORDER),
    cancelOrder: vi.fn(async () => {}),
    updateShippingAddress: vi.fn(async () => {}),
    createReorder: vi.fn(async () => ({ invoiceUrl: 'https://shop/checkout/abc' })),
    ...over,
  };
}

function fakeLog(over: Partial<ActionLog> = {}): ActionLog {
  return {
    hasExecuted: vi.fn(async () => false),
    record: vi.fn(async () => {}),
    ...over,
  };
}

function env(policy: ActionPolicy, ops: ActionOps, log: ActionLog, customerEmail: string | null = 'jane@acme.com'): ActionEnv {
  return {
    organisationId: 'org_1',
    conversationId: 'conv_1',
    customerEmail,
    policy,
    ops,
    log,
    now: () => new Date('2026-06-25T11:00:00Z'),
  };
}

const ALLOW_CANCEL = parseActionPolicy({ cancelOrder: { enabled: true } });

describe('executeCancelOrder', () => {
  it('is not_permitted when the merchant disabled cancellation', async () => {
    const out = await executeCancelOrder(env(DEFAULT_ACTION_POLICY, fakeOps(), fakeLog()), { confirmed: true });
    expect(out.status).toBe('not_permitted');
  });

  it('is ineligible when there is no customer email', async () => {
    const out = await executeCancelOrder(env(ALLOW_CANCEL, fakeOps(), fakeLog(), null), { confirmed: true });
    expect(out.status).toBe('ineligible');
  });

  it('is ineligible when the order is not found under the customer email', async () => {
    const ops = fakeOps({ findOrder: vi.fn(async () => null) });
    const out = await executeCancelOrder(env(ALLOW_CANCEL, ops, fakeLog()), { orderNumber: '#999', confirmed: true });
    expect(out.status).toBe('ineligible');
    expect(ops.cancelOrder).not.toHaveBeenCalled();
  });

  it('is ineligible when the order is already fulfilled and onlyIfUnfulfilled is set', async () => {
    const ops = fakeOps({ findOrder: vi.fn(async () => ({ ...ORDER, fulfillmentStatus: 'FULFILLED' })) });
    const out = await executeCancelOrder(env(ALLOW_CANCEL, ops, fakeLog()), { confirmed: true });
    expect(out.status).toBe('ineligible');
    expect(ops.cancelOrder).not.toHaveBeenCalled();
  });

  it('proposes (asks to confirm) when confirmation is required and not yet confirmed', async () => {
    const ops = fakeOps();
    const out = await executeCancelOrder(env(ALLOW_CANCEL, ops, fakeLog()), { confirmed: false });
    expect(out.status).toBe('proposed');
    expect(out.orderRef).toBe('#1001');
    expect(ops.cancelOrder).not.toHaveBeenCalled();
  });

  it('executes the cancellation when confirmed and eligible', async () => {
    const ops = fakeOps();
    const log = fakeLog();
    const out = await executeCancelOrder(env(ALLOW_CANCEL, ops, log), { confirmed: true });
    expect(out.status).toBe('executed');
    expect(ops.cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER.id }));
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'cancelOrder', status: 'executed' }));
  });

  it('is failed (and logged) when the Shopify mutation throws', async () => {
    const ops = fakeOps({ cancelOrder: vi.fn(async () => { throw new Error('shopify boom'); }) });
    const log = fakeLog();
    const out = await executeCancelOrder(env(ALLOW_CANCEL, ops, log), { confirmed: true });
    expect(out.status).toBe('failed');
    expect(log.record).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'cancelOrder', status: 'failed' }));
  });

  it('is idempotent: an already-executed cancel does not call Shopify again', async () => {
    const ops = fakeOps();
    const log = fakeLog({ hasExecuted: vi.fn(async () => true) });
    const out = await executeCancelOrder(env(ALLOW_CANCEL, ops, log), { confirmed: true });
    expect(out.status).toBe('executed');
    expect(ops.cancelOrder).not.toHaveBeenCalled();
  });

  it('honours the maxHoursAfterOrder guardrail', async () => {
    const policy = parseActionPolicy({ cancelOrder: { enabled: true, maxHoursAfterOrder: 0.5 } });
    // now is 1h after the order; window is 0.5h ⇒ too late.
    const ops = fakeOps();
    const out = await executeCancelOrder(env(policy, ops, fakeLog()), { confirmed: true });
    expect(out.status).toBe('ineligible');
    expect(ops.cancelOrder).not.toHaveBeenCalled();
  });
});

describe('executeReorder', () => {
  const ALLOW_REORDER = DEFAULT_ACTION_POLICY; // reorder is on by default

  it('creates a reorder link without requiring confirmation', async () => {
    const ops = fakeOps();
    const out = await executeReorder(env(ALLOW_REORDER, ops, fakeLog()), { confirmed: false });
    expect(out.status).toBe('executed');
    expect(out.detail?.invoiceUrl).toBe('https://shop/checkout/abc');
    expect(ops.createReorder).toHaveBeenCalled();
  });

  it('is not_permitted when reorder is disabled', async () => {
    const policy = parseActionPolicy({ reorder: { enabled: false } });
    const out = await executeReorder(env(policy, fakeOps(), fakeLog()), { confirmed: true });
    expect(out.status).toBe('not_permitted');
  });

  it('is ineligible when the order is not found', async () => {
    const ops = fakeOps({ findOrder: vi.fn(async () => null) });
    const out = await executeReorder(env(ALLOW_REORDER, ops, fakeLog()), { orderNumber: '#999', confirmed: true });
    expect(out.status).toBe('ineligible');
  });

  it('is failed when reorder creation throws', async () => {
    const ops = fakeOps({ createReorder: vi.fn(async () => { throw new Error('nope'); }) });
    const out = await executeReorder(env(ALLOW_REORDER, ops, fakeLog()), { confirmed: true });
    expect(out.status).toBe('failed');
  });
});

describe('executeEditAddress', () => {
  const ALLOW_EDIT = parseActionPolicy({ editAddress: { enabled: true } });
  const ADDR = { address1: '1 New St', city: 'Pune', zip: '411001', country: 'India' };

  it('proposes when confirmation is required and not confirmed', async () => {
    const ops = fakeOps();
    const out = await executeEditAddress(env(ALLOW_EDIT, ops, fakeLog()), { address: ADDR, confirmed: false });
    expect(out.status).toBe('proposed');
    expect(ops.updateShippingAddress).not.toHaveBeenCalled();
  });

  it('updates the address when confirmed and unfulfilled', async () => {
    const ops = fakeOps();
    const out = await executeEditAddress(env(ALLOW_EDIT, ops, fakeLog()), { address: ADDR, confirmed: true });
    expect(out.status).toBe('executed');
    expect(ops.updateShippingAddress).toHaveBeenCalledWith(expect.objectContaining({ orderId: ORDER.id }));
  });

  it('is ineligible when already fulfilled', async () => {
    const ops = fakeOps({ findOrder: vi.fn(async () => ({ ...ORDER, fulfillmentStatus: 'FULFILLED' })) });
    const out = await executeEditAddress(env(ALLOW_EDIT, ops, fakeLog()), { address: ADDR, confirmed: true });
    expect(out.status).toBe('ineligible');
  });
});

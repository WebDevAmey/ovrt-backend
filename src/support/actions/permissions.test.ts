import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACTION_POLICY,
  parseActionPolicy,
  isActionEnabled,
  enabledActions,
  type ActionPolicy,
} from './permissions.js';

describe('parseActionPolicy', () => {
  it('returns safe defaults for empty/missing config', () => {
    const policy = parseActionPolicy(undefined);
    expect(policy.cancelOrder.enabled).toBe(false);
    expect(policy.editAddress.enabled).toBe(false);
    expect(policy.initiateReturn.enabled).toBe(false);
    expect(policy.refund.enabled).toBe(false);
    // Reorder is non-destructive, so it is on by default.
    expect(policy.reorder.enabled).toBe(true);
    // Irreversible actions ask the customer to confirm by default.
    expect(policy.requireCustomerConfirmation).toBe(true);
  });

  it('treats null and {} the same as missing (defaults)', () => {
    expect(parseActionPolicy(null)).toEqual(DEFAULT_ACTION_POLICY);
    expect(parseActionPolicy({})).toEqual(DEFAULT_ACTION_POLICY);
  });

  it('merges merchant toggles over the defaults', () => {
    const policy = parseActionPolicy({ cancelOrder: { enabled: true }, refund: { enabled: true } });
    expect(policy.cancelOrder.enabled).toBe(true);
    expect(policy.refund.enabled).toBe(true);
    // Untouched actions keep their defaults.
    expect(policy.editAddress.enabled).toBe(false);
    expect(policy.reorder.enabled).toBe(true);
  });

  it('carries guardrail values when supplied', () => {
    const policy = parseActionPolicy({
      cancelOrder: { enabled: true, onlyIfUnfulfilled: false, maxHoursAfterOrder: 24 },
      refund: { enabled: true, maxAmount: 5000 },
    });
    expect(policy.cancelOrder.onlyIfUnfulfilled).toBe(false);
    expect(policy.cancelOrder.maxHoursAfterOrder).toBe(24);
    expect(policy.refund.maxAmount).toBe(5000);
  });

  it('ignores wrong-typed fields and falls back to defaults', () => {
    const policy = parseActionPolicy({
      cancelOrder: { enabled: 'yes', maxHoursAfterOrder: 'soon' },
      requireCustomerConfirmation: 'maybe',
    });
    expect(policy.cancelOrder.enabled).toBe(false);
    expect(policy.cancelOrder.maxHoursAfterOrder).toBeNull();
    expect(policy.requireCustomerConfirmation).toBe(true);
  });

  it('lets the merchant disable customer confirmation', () => {
    expect(parseActionPolicy({ requireCustomerConfirmation: false }).requireCustomerConfirmation).toBe(false);
  });
});

describe('isActionEnabled', () => {
  it('reflects the policy for each action', () => {
    const policy: ActionPolicy = parseActionPolicy({ cancelOrder: { enabled: true } });
    expect(isActionEnabled(policy, 'cancelOrder')).toBe(true);
    expect(isActionEnabled(policy, 'reorder')).toBe(true);
    expect(isActionEnabled(policy, 'refund')).toBe(false);
  });
});

describe('enabledActions', () => {
  it('lists only reorder by default', () => {
    expect(enabledActions(DEFAULT_ACTION_POLICY)).toEqual(['reorder']);
  });

  it('lists every enabled action', () => {
    const policy = parseActionPolicy({
      cancelOrder: { enabled: true },
      editAddress: { enabled: true },
    });
    expect(enabledActions(policy).sort()).toEqual(['cancelOrder', 'editAddress', 'reorder'].sort());
  });
});

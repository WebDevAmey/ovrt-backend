import { describe, it, expect } from 'vitest';
import { getPlaybook, selectPlaybooks } from './registry.js';
import { SUPPORT_TOPICS } from './topics.js';
import type { ActionType } from '../actions/permissions.js';

const NONE: ReadonlySet<ActionType> = new Set();

describe('registry completeness', () => {
  it('has a playbook for every topic', () => {
    for (const t of SUPPORT_TOPICS) {
      const pb = getPlaybook(t);
      expect(pb.id).toBe(t);
      expect(pb.guidance.length).toBeGreaterThan(0);
    }
  });
});

describe('selectPlaybooks', () => {
  it('returns the base guidance for a single topic', () => {
    const text = selectPlaybooks(['ORDER_STATUS'], NONE);
    expect(text).toContain(getPlaybook('ORDER_STATUS').guidance);
  });

  it('composes guidance for two topics', () => {
    const text = selectPlaybooks(['DAMAGED_WRONG_MISSING', 'PRODUCT_AVAILABILITY'], NONE);
    expect(text).toContain(getPlaybook('DAMAGED_WRONG_MISSING').guidance);
    expect(text).toContain(getPlaybook('PRODUCT_AVAILABILITY').guidance);
  });

  it('tells the agent it cannot cancel when the action is not performable', () => {
    const text = selectPlaybooks(['CANCEL_ORDER'], NONE);
    expect(text.toLowerCase()).toContain('not permitted');
    expect(text.toLowerCase()).toContain('escalate');
    // Must NOT instruct the agent to call a tool it does not have.
    expect(text).not.toContain('cancelOrder tool');
  });

  it('tells the agent it CAN cancel (with confirmation) when the action is performable', () => {
    const text = selectPlaybooks(['CANCEL_ORDER'], new Set<ActionType>(['cancelOrder']));
    expect(text).toContain('cancelOrder');
    expect(text.toLowerCase()).toContain('confirm');
  });

  it('only surfaces action guidance for the playbook actions involved', () => {
    // An order-status question involves no write action — no action guidance appended.
    const text = selectPlaybooks(['ORDER_STATUS'], new Set<ActionType>(['cancelOrder', 'refund']));
    expect(text).not.toContain('cancelOrder tool');
  });

  it('falls back to the OTHER playbook for an empty topic list', () => {
    const text = selectPlaybooks([], NONE);
    expect(text).toContain(getPlaybook('OTHER').guidance);
  });

  it('does not duplicate a shared action across two topics', () => {
    // REFUND and RETURN_EXCHANGE may both reference the refund/return actions;
    // the composed guidance should mention an action's performable line once.
    const text = selectPlaybooks(['REFUND', 'RETURN_EXCHANGE'], new Set<ActionType>(['refund', 'initiateReturn']));
    const occurrences = text.split('refund tool').length - 1;
    expect(occurrences).toBeLessThanOrEqual(1);
  });
});

import { describe, it, expect } from 'vitest';
import { triageInbound } from './triage.js';
import type { AgentRule } from './rules.js';
import type { ChannelSignals } from './channel-adapter.js';

const NO_SIGNALS: ChannelSignals = { hardNegative: false, softNegative: false, isReply: false, reasons: [] };

function refundRule(overrides: Partial<AgentRule> = {}): AgentRule {
  return {
    id: 'rule_refund',
    name: 'Refund handling',
    priority: 10,
    matchType: 'KEYWORD',
    matchValue: ['refund'],
    actionType: 'TEMPLATE',
    responseTemplate: 'We are sorry — here is how refunds work...',
    directive: null,
    isActive: true,
    ...overrides,
  };
}

describe('triageInbound — low-confidence + matching rule', () => {
  it('clears lowConfidence when an org rule matches a borderline support message', async () => {
    // "need refund" scores in the ambiguous band → classifier keeps it but flags
    // lowConfidence. A refund rule means the business explicitly handles this, so
    // the flag must be cleared (otherwise escalateOnLowConfidence needlessly
    // hands it to a human).
    const decision = await triageInbound(
      { subject: '', body: 'need refund', from: 'jane@acme.com', signals: NO_SIGNALS },
      [refundRule()],
    );

    expect(decision.keep).toBe(true);
    expect(decision.via).toBe('org-rule');
    expect(decision.classification.lowConfidence).toBe(false);
    expect(decision.classification.isSupport).toBe(true);
  });

  it('leaves lowConfidence set when no rule matches the borderline message', async () => {
    const decision = await triageInbound(
      { subject: '', body: 'need refund', from: 'jane@acme.com', signals: NO_SIGNALS },
      [],
    );

    expect(decision.keep).toBe(true);
    // No rule cleared it — still flagged so the org's low-confidence policy applies.
    expect(decision.classification.lowConfidence).toBe(true);
  });

  it('does not run the rule check for a confidently-support message (rule does not change the verdict)', async () => {
    const decision = await triageInbound(
      { subject: 'My order is broken and damaged', body: 'the item arrived damaged, I need a refund', from: 'jane@acme.com', signals: NO_SIGNALS },
      [refundRule()],
    );

    expect(decision.keep).toBe(true);
    expect(decision.via).toBe('classifier');
    expect(decision.classification.lowConfidence).toBe(false);
  });

  it('ignores inactive rules when clearing the flag', async () => {
    const decision = await triageInbound(
      { subject: '', body: 'need refund', from: 'jane@acme.com', signals: NO_SIGNALS },
      [refundRule({ isActive: false })],
    );

    expect(decision.classification.lowConfidence).toBe(true);
  });
});

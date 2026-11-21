import { describe, it, expect } from 'vitest';
import { matchRules, type AgentRule } from './rules.js';

function rule(p: Partial<AgentRule>): AgentRule {
  return {
    id: 'rule_1',
    name: 'Rule',
    priority: 0,
    matchType: 'ALWAYS',
    matchValue: [],
    actionType: 'DIRECTIVE',
    responseTemplate: null,
    directive: null,
    isActive: true,
    ...p,
  };
}

describe('matchRules', () => {
  it('matches KEYWORD rules against subject or body, case-insensitively', () => {
    const rules = [rule({ id: 'r1', matchType: 'KEYWORD', matchValue: ['Refund'], actionType: 'DIRECTIVE', directive: 'Offer a refund' })];
    const hit = matchRules({ subject: 'I want a refund', body: '', from: 'jane@acme.com' }, rules);
    expect(hit.matched.map((r) => r.id)).toEqual(['r1']);
    expect(hit.directives).toEqual(['Offer a refund']);

    const miss = matchRules({ subject: 'Hello', body: 'just saying hi', from: 'jane@acme.com' }, rules);
    expect(miss.matched).toEqual([]);
  });

  it('matches SENDER_DOMAIN rules on the exact domain or a subdomain', () => {
    const rules = [rule({ id: 'r1', matchType: 'SENDER_DOMAIN', matchValue: ['vip.com'], actionType: 'DIRECTIVE', directive: 'Be extra polite' })];

    const exact = matchRules({ subject: '', body: '', from: '"Jane" <jane@vip.com>' }, rules);
    expect(exact.matched.map((r) => r.id)).toEqual(['r1']);

    const subdomain = matchRules({ subject: '', body: '', from: 'jane@eu.vip.com' }, rules);
    expect(subdomain.matched.map((r) => r.id)).toEqual(['r1']);

    const other = matchRules({ subject: '', body: '', from: 'jane@other.com' }, rules);
    expect(other.matched).toEqual([]);
  });

  it('ALWAYS rules match every message', () => {
    const rules = [rule({ id: 'r1', matchType: 'ALWAYS', actionType: 'DIRECTIVE', directive: 'Always sign off warmly' })];
    const result = matchRules({ subject: 'anything', body: 'anything', from: 'x@y.com' }, rules);
    expect(result.matched.map((r) => r.id)).toEqual(['r1']);
  });

  it('ignores inactive rules', () => {
    const rules = [rule({ id: 'r1', matchType: 'ALWAYS', isActive: false, actionType: 'DIRECTIVE', directive: 'x' })];
    const result = matchRules({ subject: '', body: '', from: 'x@y.com' }, rules);
    expect(result.matched).toEqual([]);
  });

  it('orders matched rules by priority, descending', () => {
    const rules = [
      rule({ id: 'low', priority: 1, matchType: 'ALWAYS', actionType: 'DIRECTIVE', directive: 'low' }),
      rule({ id: 'high', priority: 10, matchType: 'ALWAYS', actionType: 'DIRECTIVE', directive: 'high' }),
      rule({ id: 'mid', priority: 5, matchType: 'ALWAYS', actionType: 'DIRECTIVE', directive: 'mid' }),
    ];
    const result = matchRules({ subject: '', body: '', from: 'x@y.com' }, rules);
    expect(result.matched.map((r) => r.id)).toEqual(['high', 'mid', 'low']);
    expect(result.directives).toEqual(['high', 'mid', 'low']);
  });

  it('surfaces the first matched ESCALATE rule and the first matched TEMPLATE rule', () => {
    const rules = [
      rule({ id: 'tmpl', priority: 5, matchType: 'KEYWORD', matchValue: ['hours'], actionType: 'TEMPLATE', responseTemplate: 'We are open 9-5.' }),
      rule({ id: 'esc', priority: 10, matchType: 'KEYWORD', matchValue: ['lawsuit'], actionType: 'ESCALATE' }),
    ];
    const result = matchRules({ subject: 'lawsuit threat re: hours', body: '', from: 'jane@acme.com' }, rules);
    expect(result.escalate?.id).toBe('esc');
    expect(result.template?.id).toBe('tmpl');
  });

  it('returns null escalate/template and an empty directives array when nothing matches', () => {
    const rules = [rule({ id: 'r1', matchType: 'KEYWORD', matchValue: ['foo'], actionType: 'DIRECTIVE', directive: 'bar' })];
    const result = matchRules({ subject: 'unrelated', body: 'unrelated', from: 'jane@acme.com' }, rules);
    expect(result.escalate).toBeNull();
    expect(result.template).toBeNull();
    expect(result.directives).toEqual([]);
  });
});

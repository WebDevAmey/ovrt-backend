/**
 * Agent rule matching (pure)
 * ==========================
 * Decides which of an org's configured SupportAgentRules apply to an inbound
 * message, and what the agent should do as a result. No DB, no LLM — pure
 * function over the rule rows and the message text, so it's unit-testable.
 *
 * Match types:
 *   KEYWORD / INTENT — any matchValue term appears (case-insensitive) in the
 *                      subject or body. (INTENT is treated as keyword matching
 *                      for now; the enum reserves room for a smarter matcher.)
 *   SENDER_DOMAIN    — the sender address's domain equals one of matchValue.
 *   ALWAYS           — matches every message (a catch-all / default directive).
 *
 * Rules are evaluated in priority order (desc, then creation order as given by
 * the caller). A matched ESCALATE rule wins outright — we don't auto-answer.
 */

export type AgentRule = {
  id: string;
  name: string;
  priority: number;
  matchType: 'KEYWORD' | 'INTENT' | 'SENDER_DOMAIN' | 'ALWAYS';
  matchValue: string[];
  actionType: 'TEMPLATE' | 'DIRECTIVE' | 'ESCALATE';
  responseTemplate: string | null;
  directive: string | null;
  isActive: boolean;
};

export type RuleMatchInput = {
  subject: string;
  body: string;
  from: string;
};

export type RuleMatchResult = {
  /** Active rules that matched, highest priority first. */
  matched: AgentRule[];
  /** A matched ESCALATE rule, if any — caller should hand off to a human. */
  escalate: AgentRule | null;
  /** First matched TEMPLATE rule — a verbatim canned reply, if any. */
  template: AgentRule | null;
  /** Matched DIRECTIVE rules' directives, in priority order (for the LLM). */
  directives: string[];
};

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at === -1) return '';
  // Strip a trailing ">" from "Name <a@b.com>" forms.
  return address.slice(at + 1).replace(/[>\s]+$/, '').toLowerCase();
}

function ruleMatches(rule: AgentRule, input: RuleMatchInput): boolean {
  const terms = rule.matchValue.map((t) => t.toLowerCase()).filter(Boolean);

  switch (rule.matchType) {
    case 'ALWAYS':
      return true;
    case 'SENDER_DOMAIN': {
      const dom = domainOf(input.from);
      return terms.some((t) => dom === t || dom.endsWith(`.${t}`));
    }
    case 'KEYWORD':
    case 'INTENT': {
      if (terms.length === 0) return false;
      const hay = `${input.subject}\n${input.body}`.toLowerCase();
      return terms.some((t) => hay.includes(t));
    }
    default:
      return false;
  }
}

export function matchRules(input: RuleMatchInput, rules: AgentRule[]): RuleMatchResult {
  const ordered = rules
    .filter((r) => r.isActive)
    .sort((a, b) => b.priority - a.priority);

  const matched = ordered.filter((r) => ruleMatches(r, input));

  const escalate = matched.find((r) => r.actionType === 'ESCALATE') ?? null;
  const template = matched.find((r) => r.actionType === 'TEMPLATE') ?? null;
  const directives = matched
    .filter((r) => r.actionType === 'DIRECTIVE' && r.directive)
    .map((r) => r.directive as string);

  return { matched, escalate, template, directives };
}

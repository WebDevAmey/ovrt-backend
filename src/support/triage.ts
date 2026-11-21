/**
 * Inbound-message triage cascade (pure-ish, channel-agnostic)
 * =============================================================
 * Decides the fate of one inbound message through a cheapest-first cascade,
 * used by every channel's webhook. Depends only on the classifier, the intent
 * gate, and the rule matcher — no DB — so it's unit-testable without a
 * database.
 *
 * The deterministic classifier remains the front line; the LLM intent gate and
 * the org's own rules only ever RESCUE a message the classifier would have
 * dropped — they never drop one it kept. This is what fixes silently-dropped
 * customer questions: the keyword lexicon can't enumerate every phrasing, and
 * the org's configured rules (which used to live only in the downstream agent)
 * now get a say in whether a message is kept at all.
 */

import { classifyMail, type Classification, type ClassifierInput } from './classifier.js';
import { classifyIntent } from './intent.js';
import { matchRules, type AgentRule } from './rules.js';
import type { SupportIntent } from '../../lib/generated/prisma/enums.js';

export type TriageDecision = {
  /** Whether to ingest this message as a customer conversation. */
  keep: boolean;
  /** Which gate decided it, for the log. */
  via: 'classifier' | 'org-rule' | 'intent' | 'intent-fallback';
  /** A Classification to carry forward to ingest (shape unchanged for callers). */
  classification: Classification;
  /** The intent bucket, when the LLM gate ran. */
  intent?: SupportIntent;
};

/**
 * Triage one inbound message.
 *
 *   1. classifyMail (free, deterministic).
 *      - isSupport → keep. Hard-rule promo (conf ≥ 0.9) → drop immediately,
 *        no further gates (this is the cheap bulk/marketing filter).
 *   2. Org rules (B): a configured rule match (e.g. the "Stock questions"
 *      directive) means the business has explicitly asked to handle this →
 *      keep, regardless of the lexicon score.
 *   3. Intent gate (C): a small-model second opinion for the ambiguous middle
 *      band. Generalises across phrasings the keyword lexicon can't enumerate.
 *      If the model is unavailable, fall back to the deterministic decision.
 *
 * Returning a Classification on every path keeps ingestInboundMessage's
 * contract unchanged; the rescue paths synthesise one with isSupport=true.
 */
export async function triageInbound(input: ClassifierInput, rules: AgentRule[]): Promise<TriageDecision> {
  const classification = await classifyMail(input);

  if (classification.isSupport) {
    // The classifier kept it. If it was only kept on the inclusive-ambiguity
    // bias (lowConfidence), a matching org rule means the business explicitly
    // handles this category — clear the flag so the downstream agent isn't
    // needlessly escalated by escalateOnLowConfidence. A confident keep needs
    // no rule check.
    if (classification.lowConfidence) {
      const ruleResult = matchRules({ subject: input.subject, body: input.body, from: input.from }, rules);
      if (ruleResult.matched.length > 0) {
        const matchedNames = ruleResult.matched.map((r) => r.name).join(', ');
        return {
          keep: true,
          via: 'org-rule',
          classification: {
            ...classification,
            lowConfidence: false,
            reasons: [...classification.reasons, `org-rule:[${matchedNames}]`],
          },
        };
      }
    }
    return { keep: true, via: 'classifier', classification };
  }

  // A high-confidence hard-rule promo verdict is decisive and cheap — don't
  // spend an org-rule check or an LLM call on obvious marketing/bulk noise.
  const hardPromo = classification.label === 'promotion' && classification.confidence >= 0.9;
  if (hardPromo) {
    return { keep: false, via: 'classifier', classification };
  }

  // (B) Org rules are authoritative: a matched rule rescues the message.
  const ruleResult = matchRules({ subject: input.subject, body: input.body, from: input.from }, rules);
  if (ruleResult.matched.length > 0) {
    const matchedNames = ruleResult.matched.map((r) => r.name).join(', ');
    return {
      keep: true,
      via: 'org-rule',
      classification: {
        ...classification,
        label: 'support',
        isSupport: true,
        // It cleared the bar on an explicit org rule, not on score — but it's a
        // deliberate keep, not the inclusive-ambiguity bias, so don't flag it
        // low-confidence (that would needlessly trip escalateOnLowConfidence).
        lowConfidence: false,
        reasons: [...classification.reasons, `org-rule:[${matchedNames}]`],
      },
    };
  }

  // (C) LLM intent gate for the ambiguous middle band.
  const intent = await classifyIntent({
    topic: input.subject,
    body: input.body,
    fromHandle: input.from,
  });

  if (!intent) {
    // Model unavailable — fall back to the deterministic verdict (drop).
    return { keep: false, via: 'intent-fallback', classification };
  }

  if (intent.isCustomerQuestion) {
    return {
      keep: true,
      via: 'intent',
      intent: intent.intent,
      classification: {
        ...classification,
        label: 'support',
        isSupport: true,
        lowConfidence: false,
        reasons: [...classification.reasons, `intent:${intent.intent} (${intent.reason})`],
      },
    };
  }

  return { keep: false, via: 'intent', intent: intent.intent, classification };
}

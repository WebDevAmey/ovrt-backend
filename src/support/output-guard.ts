/**
 * Output guard (fail-safe leak detector)
 * =======================================
 * Last line of defence before a model-drafted reply is shown to a customer.
 * Rejects bodies that leak prompt structure (delimiter tags, system-prompt
 * fingerprints) or violate the disposition's shape (answer/clarify with an
 * empty body). On rejection the runner converts the reply to
 * `disposition: 'escalate'` — never auto-send a rejected body.
 */

import type { ReplyOutput } from './reply-schema.js';

/** Strings that should never appear in a customer-facing reply. */
const LEAK_PATTERNS: RegExp[] = [
  /<customer_message/i,
  /<\/customer_message/i,
  /<customer_name/i,
  /<customer_topic/i,
  /<conversation>/i,
  /<agent_message/i,
  /<omitted/i,
  /UNTRUSTED INPUT/i,
  /GROUNDING — NON-NEGOTIABLE/i,
  /CHOOSING A DISPOSITION/i,
  /SIGNATURE: if drafting/i,
  /VOICE & TONE:/i,
  /GENERAL INSTRUCTIONS:/i,
  /APPLICABLE RULES FOR THIS MESSAGE/i,
  /you are a customer support agent replying on behalf/i,
];

export type OutputGuardResult = { rejected: false } | { rejected: true; reason: string };

/**
 * Validate a model's structured reply before it's persisted as a draft.
 * Returns `{ rejected: true, reason }` if the output should be treated as an
 * escalation instead of a draft.
 */
export function validateReply(out: ReplyOutput): OutputGuardResult {
  if (out.disposition === 'escalate') {
    return { rejected: false };
  }

  const body = out.body ?? '';

  if (!body.trim()) {
    return { rejected: true, reason: `empty body for disposition "${out.disposition}"` };
  }

  for (const pattern of LEAK_PATTERNS) {
    if (pattern.test(body)) {
      return { rejected: true, reason: `body matched leak pattern ${pattern}` };
    }
  }

  return { rejected: false };
}

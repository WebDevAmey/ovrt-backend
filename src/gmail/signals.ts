/**
 * Gmail-specific triage signal extraction
 * ========================================
 * Pure mapping from Gmail's labels/headers/sender into the channel-neutral
 * ChannelSignals the support classifier consumes (src/support/classifier.ts).
 *
 * A bulk/marketing/automated fingerprint (List-Unsubscribe, Precedence:bulk,
 * Gmail's CATEGORY_PROMOTIONS/SOCIAL/FORUMS, a noreply sender, auto-generated)
 * is decisive evidence the mail is NOT a person asking for help. Two
 * independent strong negatives (or CATEGORY_PROMOTIONS alone) → hardNegative.
 * Exactly one → softNegative (penalizes but doesn't decide).
 */

import type { ChannelSignals } from '../support/channel-adapter.js';

const NEGATIVE_GMAIL_CATEGORIES = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);

const NON_HUMAN_SENDER_RE =
  /(^|[._-])(no-?reply|do-?not-?reply|newsletter|mailer|notifications?|marketing|deals?|offers?|updates?)@/i;

export function extractGmailSignals(
  labelIds: string[],
  headers: Record<string, string>,
  from: string,
): ChannelSignals {
  const reasons: string[] = [];
  const labels = labelIds || [];
  const fromLower = (from || '').toLowerCase();

  const negativeCategory = labels.find((l) => NEGATIVE_GMAIL_CATEGORIES.has(l));
  if (negativeCategory) reasons.push(`gmail:${negativeCategory}`);

  const hasUnsubscribe = 'list-unsubscribe' in headers || 'list-id' in headers;
  if (hasUnsubscribe) reasons.push('header:list-unsubscribe');

  const precedence = (headers['precedence'] || '').toLowerCase();
  const isBulk = precedence === 'bulk' || precedence === 'list' || precedence === 'junk';
  if (isBulk) reasons.push(`header:precedence=${precedence}`);

  const autoSubmitted = (headers['auto-submitted'] || '').toLowerCase();
  const isAuto = (autoSubmitted && autoSubmitted !== 'no') || 'x-autoreply' in headers;
  if (isAuto) reasons.push('header:auto-submitted');

  const isNonHumanSender = NON_HUMAN_SENDER_RE.test(fromLower);
  if (isNonHumanSender) reasons.push('sender:nonhuman');

  const strongNegatives = [hasUnsubscribe, isBulk, isAuto, isNonHumanSender].filter(Boolean).length;
  const hardNegative = negativeCategory === 'CATEGORY_PROMOTIONS' || strongNegatives >= 2;
  const softNegative = !hardNegative && strongNegatives === 1;

  const isReply = 'in-reply-to' in headers || 'references' in headers;
  if (isReply) reasons.push('signal:is-reply');

  return { hardNegative, softNegative, isReply, reasons };
}

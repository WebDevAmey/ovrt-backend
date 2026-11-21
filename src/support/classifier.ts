/**
 * Support-message classifier (no LLM, channel-agnostic)
 * =======================================================
 * Decides whether an inbound message is a SUPPORT request (a customer needing
 * help: orders, refunds, complaints, "it's broken", questions) versus
 * PROMOTION (marketing/newsletters/deals) or OTHER (everything else).
 *
 * Priority is "support or not", and we err INCLUSIVE: an ambiguous message is
 * kept as support so we never silently drop a real customer issue.
 *
 * Design — a transparent two-stage cascade, fully deterministic and auditable:
 *
 *   STAGE 1 — hard rules via ChannelSignals. Each channel adapter/webhook
 *     extracts deterministic evidence (bulk/marketing fingerprints, is-this-
 *     a-reply, etc.) into a ChannelSignals object before calling here.
 *     `signals.hardNegative` is decisive evidence the message is NOT a person
 *     asking for help and short-circuits to "promotion".
 *
 *   STAGE 2 — weighted feature score. For everything else, a hand-tuned
 *     linear scorer over engineered features: support vs promo lexicons
 *     (subject weighted heavier than body), question marks, order/tracking
 *     patterns, first-person grievance phrases, signals.isReply (+) /
 *     signals.softNegative (-). The score is squashed to a confidence in
 *     [0,1] and compared to a threshold.
 *
 * Every decision returns the matched signals + score so it can be logged and
 * the weights tuned against real traffic.
 */

import type { ChannelSignals } from './channel-adapter.js';

export type MailClass = 'support' | 'promotion' | 'other';

export type ClassifierInput = {
  /** Subject/topic line, if the channel has one. */
  subject: string;
  body: string;
  from: string;
  /** Deterministic, channel-derived triage evidence (see channel-adapter.ts). */
  signals: ChannelSignals;
};

export type Classification = {
  label: MailClass;
  /** Whether this should be persisted as a support ticket. */
  isSupport: boolean;
  /** Confidence in the support decision, [0,1]. */
  confidence: number;
  /** True when kept as support only because of the inclusive ambiguity rule. */
  lowConfidence: boolean;
  /** Human-readable signals that drove the decision (for logging / tuning). */
  reasons: string[];
};

// --- tuning config ----------------------------------------------------------
// Everything tunable lives here so weights/thresholds/lexicons can be adjusted
// — or overridden per call (e.g. per-org, from env) — WITHOUT touching the
// scoring logic below. classifyMail() takes an optional partial override that's
// shallow-merged onto these defaults.

export type WeightedTerm = { term: string; weight: number };

export type ClassifierConfig = {
  /** Score (after squashing) at/above which a message is support outright. */
  supportThreshold: number;
  /**
   * Ambiguity band floor. A message in [ambiguousFloor, supportThreshold) is
   * kept as support anyway (inclusive bias) but flagged lowConfidence. Below
   * the floor → not support.
   */
  ambiguousFloor: number;
  /**
   * Logistic squash params. bias shifts where raw=0 lands: with bias=3,scale=3
   * a neutral message squashes to ~0.27 (below the floor → dropped), so a
   * message must carry positive support evidence to be kept. Roughly
   * raw+2→~0.5, raw+4→~0.7.
   */
  squashBias: number;
  squashScale: number;
  /** Lexicons (lower-cased). Phrases match as substrings; single tokens on word boundaries. */
  supportTerms: WeightedTerm[];
  promoTerms: WeightedTerm[];
};

export const CLASSIFIER_CONFIG: ClassifierConfig = {
  supportThreshold: 0.55,
  ambiguousFloor: 0.4,
  squashBias: 3,
  squashScale: 3,
  supportTerms: [
    // grievance / problem language (strongest)
    { term: 'not working', weight: 3 },
    { term: "doesn't work", weight: 3 },
    { term: 'not received', weight: 3 },
    { term: "haven't received", weight: 3 },
    { term: 'never received', weight: 3 },
    { term: 'where is my', weight: 3 },
    { term: 'still waiting', weight: 2 },
    { term: 'broken', weight: 2 },
    { term: 'defective', weight: 3 },
    { term: 'damaged', weight: 3 },
    { term: 'wrong item', weight: 3 },
    { term: 'missing', weight: 2 },
    { term: 'complaint', weight: 3 },
    { term: 'urgent', weight: 1 },
    // transactional support nouns
    { term: 'refund', weight: 3 },
    { term: 'return', weight: 2 },
    { term: 'cancel', weight: 2 },
    { term: 'cancellation', weight: 2 },
    { term: 'exchange', weight: 2 },
    { term: 'replacement', weight: 2 },
    { term: 'order', weight: 1 },
    { term: 'tracking', weight: 2 },
    { term: 'delivery', weight: 1 },
    { term: 'shipment', weight: 1 },
    { term: 'invoice', weight: 1 },
    { term: 'warranty', weight: 2 },
    // help-seeking
    { term: 'help', weight: 1 },
    { term: 'support', weight: 1 },
    { term: 'issue', weight: 2 },
    { term: 'problem', weight: 2 },
    { term: 'assistance', weight: 2 },
    { term: 'please advise', weight: 2 },
    { term: 'can you', weight: 1 },
    { term: 'how do i', weight: 1 },
    { term: 'how can i', weight: 1 },
    { term: 'question', weight: 1 },
    { term: 'enquiry', weight: 1 },
    { term: 'inquiry', weight: 1 },
    { term: 'query', weight: 1 },
    { term: 'account', weight: 1 },
    // pre-sale / product-inquiry language
    { term: 'in stock', weight: 2 },
    { term: 'out of stock', weight: 2 },
    { term: 'restock', weight: 2 },
    { term: 'do you have', weight: 2 },
    { term: 'is this available', weight: 2 },
    { term: 'stock', weight: 1 },
    { term: 'availability', weight: 1 },
    { term: 'available', weight: 1 },
    { term: 'size', weight: 1 },
    { term: 'price', weight: 1 },
    { term: 'cost', weight: 1 },
  ],
  promoTerms: [
    { term: 'unsubscribe', weight: 3 },
    { term: '% off', weight: 3 },
    { term: 'sale', weight: 2 },
    { term: 'discount', weight: 2 },
    { term: 'coupon', weight: 2 },
    { term: 'promo code', weight: 3 },
    { term: 'shop now', weight: 3 },
    { term: 'buy now', weight: 3 },
    { term: 'limited time', weight: 3 },
    { term: 'offer ends', weight: 3 },
    { term: 'free shipping', weight: 2 },
    { term: 'deal', weight: 1 },
    { term: 'best seller', weight: 2 },
    { term: 'new arrivals', weight: 2 },
    { term: 'exclusive offer', weight: 3 },
    { term: 'flash sale', weight: 3 },
    { term: 'save up to', weight: 3 },
    { term: 'don’t miss', weight: 2 },
    { term: "don't miss", weight: 2 },
    { term: 'subscribe', weight: 1 },
    { term: 'webinar', weight: 1 },
  ],
};

// --- helpers ----------------------------------------------------------------

function countTermHits(text: string, terms: WeightedTerm[]): { score: number; hits: string[] } {
  let score = 0;
  const hits: string[] = [];
  for (const { term, weight } of terms) {
    let matched = false;
    if (term.includes(' ') || term.includes('%') || /[^\w]/.test(term)) {
      // phrase / contains punctuation → substring match
      if (text.includes(term)) matched = true;
    } else {
      // single token → word-boundary match to avoid substring false positives
      const re = new RegExp(`\\b${term}\\b`, 'i');
      if (re.test(text)) matched = true;
    }
    if (matched) {
      score += weight;
      hits.push(term);
    }
  }
  return { score, hits };
}

/** Biased logistic squash → confidence in [0,1]. See ClassifierConfig.squashBias. */
function squash(raw: number, bias: number, scale: number): number {
  return 1 / (1 + Math.exp(-(raw - bias) / scale));
}

// --- main -------------------------------------------------------------------

/**
 * Classify a message as support / promotion / other.
 *
 * `async` by contract even though the current implementation is synchronous —
 * so a future heavier classifier (e.g. a local model) can be swapped in without
 * changing any caller. Pass `config` to override any tuning value (shallow-merged
 * onto CLASSIFIER_CONFIG) per call, e.g. per-org thresholds.
 */
export async function classifyMail(
  input: ClassifierInput,
  config?: Partial<ClassifierConfig>,
): Promise<Classification> {
  const cfg: ClassifierConfig = { ...CLASSIFIER_CONFIG, ...config };
  const { signals } = input;

  const reasons: string[] = [...signals.reasons];
  const subject = (input.subject || '').toLowerCase();
  const body = (input.body || '').toLowerCase();

  // ---- STAGE 1: hard rules (decisive "not support") -----------------------

  if (signals.hardNegative) {
    return {
      label: 'promotion',
      isSupport: false,
      confidence: 0.95,
      lowConfidence: false,
      reasons,
    };
  }

  // ---- STAGE 2: weighted feature score ------------------------------------

  // Lexicon hits — subject is weighted ~2x body (intent lives in the subject).
  const subjSupport = countTermHits(subject, cfg.supportTerms);
  const bodySupport = countTermHits(body, cfg.supportTerms);
  const subjPromo = countTermHits(subject, cfg.promoTerms);
  const bodyPromo = countTermHits(body, cfg.promoTerms);

  let raw = 0;
  raw += subjSupport.score * 2 + bodySupport.score;
  raw -= subjPromo.score * 2 + bodyPromo.score;

  if (subjSupport.hits.length) reasons.push(`subj+[${subjSupport.hits.join(',')}]`);
  if (bodySupport.hits.length) reasons.push(`body+[${bodySupport.hits.join(',')}]`);
  if (subjPromo.hits.length) reasons.push(`subj-[${subjPromo.hits.join(',')}]`);
  if (bodyPromo.hits.length) reasons.push(`body-[${bodyPromo.hits.join(',')}]`);

  // Is-a-reply: replies into the inbox are conversational, support-leaning.
  if (signals.isReply) {
    raw += 2;
    reasons.push('signal:is-reply');
  }

  // Direct questions correlate with help-seeking.
  const questionCount = (subject.match(/\?/g)?.length ?? 0) + (body.match(/\?/g)?.length ?? 0);
  if (questionCount > 0) {
    raw += Math.min(questionCount, 3) * 0.5;
    reasons.push(`signal:questions=${questionCount}`);
  }

  // Order / tracking number patterns (e.g. "#10234", "order 10234", "ABC-123456").
  if (/(?:order|#|tracking|awb|ref)\s*[:#]?\s*[a-z]*\d{4,}/i.test(`${subject} ${body}`)) {
    raw += 1.5;
    reasons.push('signal:order-ref');
  }

  // First-person grievance ("my order", "I haven't", "I want a refund").
  if (/\b(my|i)\b[^.?!]{0,40}\b(order|refund|return|item|package|product|account|payment)\b/i.test(`${subject} ${body}`)) {
    raw += 1.5;
    reasons.push('signal:first-person-grievance');
  }

  // Soft penalty for a single weak negative signal that didn't trip hardNegative.
  if (signals.softNegative) {
    raw -= 2;
    reasons.push('signal:single-marketing-flag');
  }

  const confidence = squash(raw, cfg.squashBias, cfg.squashScale);
  reasons.push(`score:${raw.toFixed(1)}→${confidence.toFixed(2)}`);

  // ---- decision (inclusive on ambiguity) ----------------------------------

  if (confidence >= cfg.supportThreshold) {
    return { label: 'support', isSupport: true, confidence, lowConfidence: false, reasons };
  }
  if (confidence >= cfg.ambiguousFloor) {
    // Keep it — but flagged. Inclusive bias: don't drop a possible real ticket.
    return { label: 'support', isSupport: true, confidence, lowConfidence: true, reasons };
  }

  // Clearly not support. Distinguish promotion from other for the log.
  const promoSeen = subjPromo.hits.length + bodyPromo.hits.length > 0;
  return {
    label: promoSeen ? 'promotion' : 'other',
    isSupport: false,
    confidence,
    lowConfidence: false,
    reasons,
  };
}

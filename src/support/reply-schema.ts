/**
 * Structured reply schema (shared)
 * ================================
 * The agent's final decision, kept separate from both the prompt and the brain
 * so the schema and its field docs live in one place and can't drift.
 */

import { z } from 'zod';

/**
 * Insight type taxonomy — MUST stay in exact sync with the Prisma `InsightType`
 * enum (prisma/schema.prisma). A drift would make customerInsight.createMany
 * throw. reply-schema.test.ts asserts equality with the generated enum.
 */
export const INSIGHT_TYPES = [
  'PRODUCT_QUALITY',
  'WRONG_OR_DAMAGED_ITEM',
  'FAQ_GAP',
  'FEATURE_REQUEST',
  'STOCK_REQUEST',
  'SHIPPING_PAIN',
  'PRAISE',
  'OTHER',
] as const;

/** Sentiment values — kept in sync with the Prisma `InsightSentiment` enum. */
export const INSIGHT_SENTIMENTS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const;

export const insightSchema = z.object({
  type: z.enum(INSIGHT_TYPES).describe('Which kind of actionable signal this is.'),
  sentiment: z.enum(INSIGHT_SENTIMENTS),
  summary: z
    .string()
    .describe('One short, normalized sentence describing the signal for store improvement. No PII, no order numbers.'),
  snippet: z
    .string()
    .describe(
      'The exact customer wording that carries the signal, copied VERBATIM from their message — ' +
        'never paraphrased, summarized, or invented.',
    ),
  // Required-but-nullable (NOT .optional()): OpenAI's strict structured-output
  // mode requires every property to be listed in `required`, so an omittable
  // field is rejected. The model emits null when no product is named.
  productHint: z
    .string()
    .nullable()
    .describe('The product the signal is about, if the customer named one. Otherwise null.'),
});

export const replyOutputSchema = z.object({
  disposition: z
    .enum(['answer', 'clarify', 'escalate'])
    .describe(
      "How to handle this message. 'answer' = draft a normal reply. " +
        "'clarify' = draft a reply that asks the customer for missing detail " +
        '(use this — NOT escalate — when a lookup found nothing or the request is ' +
        "ambiguous). 'escalate' = hand to a human (only for genuinely sensitive/risky cases). " +
        "IMPORTANT: If an 'APPLICABLE RULE' governs the message, follow it and 'answer' " +
        "instead of escalating.",
    ),
  reviewReason: z
    .string()
    .nullable()
    .describe(
      "If disposition is 'escalate', a short internal note for a teammate explaining why. Otherwise null.",
    ),
  body: z
    .string()
    .describe("The reply body for 'answer' or 'clarify'. Empty string when disposition is 'escalate'."),
  // Required (NOT .default()/.optional()): OpenAI strict structured-output mode
  // requires every property in `required`. The model returns an empty array when
  // there is no signal; consumers handle the empty case.
  insights: z
    .array(insightSchema)
    .max(5)
    .describe(
      'Actionable signals worth remembering from THIS customer message — a product-quality ' +
        'complaint, a wrong/damaged item, a recurring question the store should document (FAQ gap), ' +
        'a feature or restock request, shipping/delivery pain, or genuine praise. Return an EMPTY ' +
        'array [] when the message carries no real signal (most do not). NEVER fabricate one to ' +
        'fill the array; capturing nothing is correct and expected. These are for internal store ' +
        'improvement only — they never change your reply body or disposition.',
    ),
});

export type ReplyOutput = z.infer<typeof replyOutputSchema>;
export type ReplyInsight = z.infer<typeof insightSchema>;

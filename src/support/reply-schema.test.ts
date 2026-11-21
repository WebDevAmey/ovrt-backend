import { describe, it, expect } from 'vitest';
import { InsightSentiment, InsightType } from '../../lib/generated/prisma/enums.js';
import { INSIGHT_SENTIMENTS, INSIGHT_TYPES, replyOutputSchema } from './reply-schema.js';

/**
 * The Zod insight enums MUST stay in exact sync with the generated Prisma enums.
 * A drift would make customerInsight.createMany throw at runtime (the runner
 * passes these string literals straight into Prisma). These tests fail loudly
 * if someone edits one side without the other.
 */
describe('insight enum parity with Prisma', () => {
  it('INSIGHT_TYPES matches the Prisma InsightType enum exactly', () => {
    expect([...INSIGHT_TYPES].sort()).toEqual(Object.values(InsightType).sort());
  });

  it('INSIGHT_SENTIMENTS matches the Prisma InsightSentiment enum exactly', () => {
    expect([...INSIGHT_SENTIMENTS].sort()).toEqual(Object.values(InsightSentiment).sort());
  });
});

describe('replyOutputSchema insights', () => {
  it('requires insights to be present (OpenAI strict mode forbids optional/defaulted fields)', () => {
    // The model must always emit insights (an empty array when there is no
    // signal). A required field keeps the JSON schema strict-mode compatible.
    const parsed = replyOutputSchema.safeParse({ disposition: 'answer', reviewReason: null, body: 'Hi' });
    expect(parsed.success).toBe(false);
  });

  it('accepts an explicit empty insights array', () => {
    const out = replyOutputSchema.parse({ disposition: 'answer', reviewReason: null, body: 'Hi', insights: [] });
    expect(out.insights).toEqual([]);
  });

  it('parses a well-formed insight', () => {
    const out = replyOutputSchema.parse({
      disposition: 'answer',
      reviewReason: null,
      body: 'Sorry to hear that — we will make it right.',
      insights: [
        {
          type: 'PRODUCT_QUALITY',
          sentiment: 'NEGATIVE',
          summary: 'Customer says the mug cracked after one use.',
          snippet: 'the mug cracked after one wash',
          productHint: 'ceramic mug',
        },
      ],
    });
    expect(out.insights).toHaveLength(1);
    expect(out.insights[0]?.type).toBe('PRODUCT_QUALITY');
  });

  it('rejects an unknown insight type', () => {
    const parsed = replyOutputSchema.safeParse({
      disposition: 'answer',
      reviewReason: null,
      body: 'Hi',
      insights: [{ type: 'NOT_A_TYPE', sentiment: 'NEGATIVE', summary: 'x', snippet: 'y' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('caps insights at 5', () => {
    const mk = (i: number) => ({
      type: 'OTHER' as const,
      sentiment: 'NEUTRAL' as const,
      summary: `s${i}`,
      snippet: `snip${i}`,
    });
    const parsed = replyOutputSchema.safeParse({
      disposition: 'answer',
      reviewReason: null,
      body: 'Hi',
      insights: [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)],
    });
    expect(parsed.success).toBe(false);
  });
});

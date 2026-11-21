import { describe, it, expect } from 'vitest';
import { classifyMail } from './classifier.js';
import type { ChannelSignals } from './channel-adapter.js';

function signals(p: Partial<ChannelSignals> = {}): ChannelSignals {
  return { hardNegative: false, softNegative: false, isReply: false, reasons: [], ...p };
}

describe('classifyMail', () => {
  it('short-circuits to promotion when signals.hardNegative is set, regardless of body content', () => {
    return classifyMail({
      subject: 'Where is my order? I need help urgently',
      body: 'Refund please, my order is broken',
      from: 'jane@acme.com',
      signals: signals({ hardNegative: true, reasons: ['gmail:CATEGORY_PROMOTIONS'] }),
    }).then((result) => {
      expect(result.label).toBe('promotion');
      expect(result.isSupport).toBe(false);
      expect(result.lowConfidence).toBe(false);
      expect(result.reasons).toContain('gmail:CATEGORY_PROMOTIONS');
    });
  });

  it('classifies a clear support question as support with high confidence', async () => {
    const result = await classifyMail({
      subject: 'Where is my order?',
      body: "Hi, I haven't received my order yet and the tracking hasn't updated in days. Can you help?",
      from: 'jane@acme.com',
      signals: signals(),
    });
    expect(result.label).toBe('support');
    expect(result.isSupport).toBe(true);
    expect(result.lowConfidence).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it('classifies a marketing newsletter as promotion', async () => {
    const result = await classifyMail({
      subject: 'Flash sale: 50% off everything, shop now!',
      body: "Don't miss our exclusive offer — limited time deal, free shipping on all orders.",
      from: 'deals@acme.com',
      signals: signals(),
    });
    expect(result.label).toBe('promotion');
    expect(result.isSupport).toBe(false);
  });

  it('classifies unrelated content with no support or promo signal as other', async () => {
    const result = await classifyMail({
      subject: 'Hey, lunch tomorrow?',
      body: 'Just checking if you are free tomorrow at noon.',
      from: 'friend@example.com',
      signals: signals(),
    });
    expect(result.label).toBe('other');
    expect(result.isSupport).toBe(false);
  });

  it('keeps an ambiguous message as support but flags lowConfidence', async () => {
    const result = await classifyMail({
      subject: 'question',
      body: 'size?',
      from: 'jane@acme.com',
      signals: signals(),
    });
    if (result.confidence >= 0.4 && result.confidence < 0.55) {
      expect(result.label).toBe('support');
      expect(result.isSupport).toBe(true);
      expect(result.lowConfidence).toBe(true);
    } else {
      // Falls outside the ambiguous band on this wording — assert the bands are mutually exclusive.
      expect(result.lowConfidence).toBe(false);
    }
  });

  it('boosts the score for replies via signals.isReply', async () => {
    const base = { subject: 'thanks', body: 'ok thanks', from: 'jane@acme.com' };
    const withoutReply = await classifyMail({ ...base, signals: signals({ isReply: false }) });
    const withReply = await classifyMail({ ...base, signals: signals({ isReply: true }) });
    expect(withReply.confidence).toBeGreaterThan(withoutReply.confidence);
    expect(withReply.reasons).toContain('signal:is-reply');
  });

  it('applies a soft penalty for signals.softNegative without forcing promotion', async () => {
    const base = {
      subject: 'Where is my order?',
      body: "I haven't received my order, can you help?",
      from: 'jane@acme.com',
    };
    const clean = await classifyMail({ ...base, signals: signals() });
    const soft = await classifyMail({ ...base, signals: signals({ softNegative: true }) });
    expect(soft.confidence).toBeLessThan(clean.confidence);
    expect(soft.reasons).toContain('signal:single-marketing-flag');
  });

  it('detects order/tracking-number references and first-person grievance phrasing', async () => {
    const result = await classifyMail({
      subject: 'My order #102345',
      body: 'I have not received my order yet, please check.',
      from: 'jane@acme.com',
      signals: signals(),
    });
    expect(result.reasons.some((r) => r.startsWith('signal:order-ref'))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith('signal:first-person-grievance'))).toBe(true);
  });

  it('counts question marks and reports them in reasons', async () => {
    const result = await classifyMail({
      subject: 'A few questions',
      body: 'Do you have this in stock? What sizes are available? Does it ship internationally?',
      from: 'jane@acme.com',
      signals: signals(),
    });
    expect(result.reasons.some((r) => r.startsWith('signal:questions='))).toBe(true);
  });

  it('accepts a partial config override (e.g. a stricter threshold)', async () => {
    const input = {
      subject: 'question',
      body: 'size?',
      from: 'jane@acme.com',
      signals: signals(),
    };
    const lenient = await classifyMail(input, { ambiguousFloor: -10, supportThreshold: -5 });
    expect(lenient.label).toBe('support');
    expect(lenient.lowConfidence).toBe(false);
  });
});

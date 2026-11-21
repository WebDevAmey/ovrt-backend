import { describe, it, expect } from 'vitest';
import { extractGmailSignals } from './signals.js';

describe('extractGmailSignals', () => {
  it('returns all-clear signals for a plain message from a person', () => {
    const result = extractGmailSignals(['INBOX'], {}, 'jane@acme.com');
    expect(result).toEqual({ hardNegative: false, softNegative: false, isReply: false, reasons: [] });
  });

  it('marks CATEGORY_PROMOTIONS alone as hardNegative', () => {
    const result = extractGmailSignals(['INBOX', 'CATEGORY_PROMOTIONS'], {}, 'deals@acme.com');
    expect(result.hardNegative).toBe(true);
    expect(result.softNegative).toBe(false);
    expect(result.reasons).toContain('gmail:CATEGORY_PROMOTIONS');
  });

  it('records CATEGORY_SOCIAL/FORUMS as a reason but does not by itself flag negative (only CATEGORY_PROMOTIONS is decisive)', () => {
    const result = extractGmailSignals(['INBOX', 'CATEGORY_SOCIAL'], {}, 'someone@example.com');
    expect(result.hardNegative).toBe(false);
    expect(result.softNegative).toBe(false);
    expect(result.reasons).toContain('gmail:CATEGORY_SOCIAL');
  });

  it('combines CATEGORY_FORUMS with two strong negatives to reach hardNegative', () => {
    const result = extractGmailSignals(
      ['INBOX', 'CATEGORY_FORUMS'],
      { precedence: 'bulk', 'list-unsubscribe': '<mailto:unsub@acme.com>' },
      'someone@example.com',
    );
    expect(result.hardNegative).toBe(true);
    expect(result.reasons).toContain('gmail:CATEGORY_FORUMS');
    expect(result.reasons).toContain('header:precedence=bulk');
    expect(result.reasons).toContain('header:list-unsubscribe');
  });

  it('treats a single weak negative (e.g. list-unsubscribe header) as softNegative', () => {
    const result = extractGmailSignals([], { 'list-unsubscribe': '<mailto:unsub@acme.com>' }, 'jane@acme.com');
    expect(result.hardNegative).toBe(false);
    expect(result.softNegative).toBe(true);
    expect(result.reasons).toContain('header:list-unsubscribe');
  });

  it('treats two independent weak negatives as hardNegative', () => {
    const result = extractGmailSignals(
      [],
      { 'list-unsubscribe': '<mailto:unsub@acme.com>', precedence: 'bulk' },
      'jane@acme.com',
    );
    expect(result.hardNegative).toBe(true);
    expect(result.softNegative).toBe(false);
    expect(result.reasons).toContain('header:list-unsubscribe');
    expect(result.reasons).toContain('header:precedence=bulk');
  });

  it('flags a noreply-style sender as a non-human-sender negative', () => {
    const result = extractGmailSignals([], {}, 'no-reply@acme.com');
    expect(result.softNegative).toBe(true);
    expect(result.reasons).toContain('sender:nonhuman');
  });

  it('flags auto-submitted / x-autoreply headers', () => {
    const result = extractGmailSignals([], { 'auto-submitted': 'auto-replied' }, 'jane@acme.com');
    expect(result.softNegative).toBe(true);
    expect(result.reasons).toContain('header:auto-submitted');
  });

  it('does not flag auto-submitted: no as a negative', () => {
    const result = extractGmailSignals([], { 'auto-submitted': 'no' }, 'jane@acme.com');
    expect(result.softNegative).toBe(false);
    expect(result.hardNegative).toBe(false);
    expect(result.reasons).not.toContain('header:auto-submitted');
  });

  it('marks isReply true when in-reply-to or references headers are present', () => {
    const withInReplyTo = extractGmailSignals([], { 'in-reply-to': '<abc@mail.gmail.com>' }, 'jane@acme.com');
    expect(withInReplyTo.isReply).toBe(true);
    expect(withInReplyTo.reasons).toContain('signal:is-reply');

    const withReferences = extractGmailSignals([], { references: '<abc@mail.gmail.com>' }, 'jane@acme.com');
    expect(withReferences.isReply).toBe(true);

    const withoutEither = extractGmailSignals([], {}, 'jane@acme.com');
    expect(withoutEither.isReply).toBe(false);
  });
});

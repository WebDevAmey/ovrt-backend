import { describe, it, expect, vi } from 'vitest';
import type { ParsedMessage } from './fetch.js';

// adapter.ts imports sendGmailReply from ./send.js, which imports
// resolveGmailConnection from ./credentials.js, which imports the Prisma
// client (requires DATABASE_URL). Mock it so this pure-logic test doesn't
// need a database.
vi.mock('./send.js', () => ({ sendGmailReply: vi.fn() }));

const { gmailAdapter, normalizeGmailInbound } = await import('./adapter.js');

function message(p: Partial<ParsedMessage>): ParsedMessage {
  return {
    id: 'msg_1',
    threadId: 'thread_1',
    from: '"Jane Doe" <jane@acme.com>',
    to: 'support@shop.com',
    subject: 'Where is my order?',
    date: '2024-01-01T00:00:00.000Z',
    snippet: 'Where is my order?',
    body: 'Where is my order?',
    labelIds: ['INBOX'],
    headers: {},
    ...p,
  };
}

describe('gmailAdapter.channelType / styleHint / usesSignature', () => {
  it('identifies as GMAIL, uses an email-framed style hint, and appends a signature', () => {
    expect(gmailAdapter.channelType).toBe('GMAIL');
    expect(gmailAdapter.styleHint).toContain('email');
    expect(gmailAdapter.usesSignature).toBe(true);
  });
});

describe('normalizeGmailInbound', () => {
  it('parses the From header into a normalized customer identity', () => {
    const result = normalizeGmailInbound(message({}));
    expect(result.externalConversationId).toBe('thread_1');
    expect(result.externalMessageId).toBe('msg_1');
    expect(result.topic).toBe('Where is my order?');
    expect(result.customer).toEqual({ displayName: 'Jane Doe', handle: 'jane@acme.com', rawHandle: '"Jane Doe" <jane@acme.com>' });
    expect(result.toHandle).toBe('support@shop.com');
    expect(result.sentAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
  });

  it('falls back to the raw From string (lower-cased) as the handle when no email can be parsed', () => {
    const result = normalizeGmailInbound(message({ from: 'Not An Email' }));
    expect(result.customer.handle).toBe('not an email');
    expect(result.customer.displayName).toBe('Not An Email');
  });

  it('captures message-id/in-reply-to/references headers into channelMeta', () => {
    const result = normalizeGmailInbound(
      message({
        headers: {
          'message-id': '<abc@mail.gmail.com>',
          'in-reply-to': '<parent@mail.gmail.com>',
          references: '<root@mail.gmail.com> <parent@mail.gmail.com>',
        },
      }),
    );
    expect(result.channelMeta).toEqual({
      messageIdHeader: '<abc@mail.gmail.com>',
      inReplyToHeader: '<parent@mail.gmail.com>',
      references: '<root@mail.gmail.com> <parent@mail.gmail.com>',
    });
  });

  it('defaults missing threading headers to null', () => {
    const result = normalizeGmailInbound(message({ headers: {} }));
    expect(result.channelMeta).toEqual({ messageIdHeader: null, inReplyToHeader: null, references: null });
  });

  it('sets sentAt to null when the message has no date', () => {
    const result = normalizeGmailInbound(message({ date: '' }));
    expect(result.sentAt).toBeNull();
  });
});

describe('gmailAdapter.replyTopic', () => {
  it('prepends "Re: " to a topic without one', () => {
    expect(gmailAdapter.replyTopic('Order status')).toBe('Re: Order status');
  });

  it('does not double-prepend when the topic already starts with "Re:" (case-insensitive)', () => {
    expect(gmailAdapter.replyTopic('Re: Order status')).toBe('Re: Order status');
    expect(gmailAdapter.replyTopic('re: order status')).toBe('re: order status');
    expect(gmailAdapter.replyTopic('RE: Order status')).toBe('RE: Order status');
  });
});

describe('gmailAdapter.buildReplyMeta', () => {
  it('threads a reply: In-Reply-To = inbound Message-ID; References = inbound References + Message-ID', () => {
    const meta = gmailAdapter.buildReplyMeta({
      externalMessageId: 'msg_1',
      channelMeta: {
        messageIdHeader: '<child@mail.gmail.com>',
        inReplyToHeader: '<parent@mail.gmail.com>',
        references: '<root@mail.gmail.com> <parent@mail.gmail.com>',
      },
    });
    expect(meta).toEqual({
      messageIdHeader: null,
      inReplyToHeader: '<child@mail.gmail.com>',
      references: '<root@mail.gmail.com> <parent@mail.gmail.com> <child@mail.gmail.com>',
    });
  });

  it('builds References from just the Message-ID when the inbound had no References chain', () => {
    const meta = gmailAdapter.buildReplyMeta({
      externalMessageId: 'msg_1',
      channelMeta: { messageIdHeader: '<only@mail.gmail.com>', inReplyToHeader: null, references: null },
    });
    expect(meta).toEqual({
      messageIdHeader: null,
      inReplyToHeader: '<only@mail.gmail.com>',
      references: '<only@mail.gmail.com>',
    });
  });

  it('degrades to all-null reply meta for malformed/empty channelMeta (un-threaded but still deliverable)', () => {
    const meta = gmailAdapter.buildReplyMeta({ externalMessageId: 'msg_1', channelMeta: {} });
    expect(meta).toEqual({ messageIdHeader: null, inReplyToHeader: null, references: null });
  });

  it('ignores non-string values in channelMeta rather than throwing', () => {
    const meta = gmailAdapter.buildReplyMeta({
      externalMessageId: 'msg_1',
      channelMeta: { messageIdHeader: 12345, inReplyToHeader: { nested: true }, references: ['array'] },
    });
    expect(meta).toEqual({ messageIdHeader: null, inReplyToHeader: null, references: null });
  });
});

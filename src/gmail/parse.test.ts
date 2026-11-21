import { describe, it, expect } from 'vitest';
import { parsePushEnvelope, shouldAdvanceCursor } from './parse.js';

function encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

describe('parsePushEnvelope', () => {
  it('decodes a well-formed push', () => {
    const env = {
      message: {
        data: encode({ emailAddress: 'ops@acme.com', historyId: 987654 }),
        messageId: 'pubsub-1',
        publishTime: '2026-06-09T10:00:00Z',
      },
      subscription: 'projects/p/subscriptions/s',
    };
    expect(parsePushEnvelope(env)).toEqual({
      messageId: 'pubsub-1',
      emailAddress: 'ops@acme.com',
      historyId: '987654', // numeric historyId coerced to string
      publishedAt: new Date('2026-06-09T10:00:00Z'),
    });
  });

  it('accepts the legacy message_id field name', () => {
    const env = {
      message: {
        data: encode({ emailAddress: 'a@b.com', historyId: '5' }),
        message_id: 'legacy-id',
      },
    };
    expect(parsePushEnvelope(env)?.messageId).toBe('legacy-id');
  });

  it('returns null when message/data/messageId missing', () => {
    expect(parsePushEnvelope({})).toBeNull();
    expect(parsePushEnvelope({ message: { messageId: 'x' } })).toBeNull();
    expect(parsePushEnvelope({ message: { data: encode({}), } })).toBeNull();
  });

  it('returns null when data is not base64 JSON', () => {
    const env = { message: { data: '!!!not-base64!!!', messageId: 'x' } };
    expect(parsePushEnvelope(env)).toBeNull();
  });

  it('returns null when payload lacks emailAddress or historyId', () => {
    const noEmail = { message: { data: encode({ historyId: '1' }), messageId: 'x' } };
    const noHist = { message: { data: encode({ emailAddress: 'a@b.com' }), messageId: 'x' } };
    expect(parsePushEnvelope(noEmail)).toBeNull();
    expect(parsePushEnvelope(noHist)).toBeNull();
  });

  it('tolerates a missing publishTime', () => {
    const env = { message: { data: encode({ emailAddress: 'a@b.com', historyId: '1' }), messageId: 'x' } };
    expect(parsePushEnvelope(env)?.publishedAt).toBeNull();
  });
});

describe('shouldAdvanceCursor', () => {
  it('advances when there is no stored cursor', () => {
    expect(shouldAdvanceCursor(null, '100')).toBe(true);
  });

  it('advances only on a strictly greater historyId', () => {
    expect(shouldAdvanceCursor('100', '101')).toBe(true);
    expect(shouldAdvanceCursor('100', '100')).toBe(false);
    expect(shouldAdvanceCursor('100', '99')).toBe(false);
  });

  it('uses BigInt comparison, not lexicographic', () => {
    // "9" > "10" lexicographically but 9 < 10 numerically.
    expect(shouldAdvanceCursor('10', '9')).toBe(false);
    // 21-digit historyIds exceed Number.MAX_SAFE_INTEGER; BigInt keeps them exact.
    expect(shouldAdvanceCursor('100000000000000000001', '100000000000000000002')).toBe(true);
  });
});

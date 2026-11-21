import { describe, it, expect } from 'vitest';
import { parseWhatsAppWebhook, type WhatsAppWebhookBody } from './parse.js';

function entryWithValue(value: Record<string, unknown>): WhatsAppWebhookBody {
  return { entry: [{ changes: [{ value }] }] };
}

describe('parseWhatsAppWebhook', () => {
  it('parses a text message', () => {
    const body = entryWithValue({
      metadata: { phone_number_id: '1234567890', display_phone_number: '15551234567' },
      contacts: [{ profile: { name: 'Jane Doe' }, wa_id: '15559876543' }],
      messages: [
        {
          id: 'wamid.1',
          from: '15559876543',
          timestamp: '1718000000',
          type: 'text',
          text: { body: 'Hi, is my order shipped?' },
        },
      ],
    });

    const result = parseWhatsAppWebhook(body);
    expect(result).toEqual([
      {
        phoneNumberId: '1234567890',
        externalMessageId: 'wamid.1',
        externalConversationId: '15559876543',
        fromHandle: '15559876543',
        displayName: 'Jane Doe',
        toHandle: '15551234567',
        body: 'Hi, is my order shipped?',
        snippet: 'Hi, is my order shipped?',
        sentAt: new Date(1718000000 * 1000),
      },
    ]);
  });

  it('parses an image message with a caption', () => {
    const body = entryWithValue({
      metadata: { phone_number_id: '1234567890' },
      messages: [
        { id: 'wamid.2', from: '15559876543', type: 'image', image: { caption: 'looks broken' } },
      ],
    });

    const result = parseWhatsAppWebhook(body);
    expect(result[0].body).toBe('[Image] looks broken');
  });

  it('parses an audio message with no caption concept', () => {
    const body = entryWithValue({
      metadata: { phone_number_id: '1234567890' },
      messages: [{ id: 'wamid.3', from: '15559876543', type: 'audio', audio: {} }],
    });

    const result = parseWhatsAppWebhook(body);
    expect(result[0].body).toBe('[Audio]');
  });

  it('drops a statuses-only payload', () => {
    const body = entryWithValue({
      metadata: { phone_number_id: '1234567890' },
      statuses: [{ id: 'wamid.1', status: 'delivered' }],
    });

    expect(parseWhatsAppWebhook(body)).toEqual([]);
  });

  it('handles a batched multi-message payload', () => {
    const body: WhatsAppWebhookBody = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1111' },
                messages: [
                  { id: 'wamid.a', from: '2222', type: 'text', text: { body: 'one' } },
                  { id: 'wamid.b', from: '3333', type: 'text', text: { body: 'two' } },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = parseWhatsAppWebhook(body);
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.body)).toEqual(['one', 'two']);
  });

  it('drops a message missing id/from', () => {
    const body = entryWithValue({
      metadata: { phone_number_id: '1234567890' },
      messages: [{ type: 'text', text: { body: 'no id or from' } }],
    });

    expect(parseWhatsAppWebhook(body)).toEqual([]);
  });

  it('drops an entry with no phone_number_id', () => {
    const body = entryWithValue({
      messages: [{ id: 'wamid.1', from: '15559876543', type: 'text', text: { body: 'hi' } }],
    });

    expect(parseWhatsAppWebhook(body)).toEqual([]);
  });

  it('returns [] for an empty body', () => {
    expect(parseWhatsAppWebhook({})).toEqual([]);
  });
});

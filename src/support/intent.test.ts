import { describe, it, expect } from 'vitest';
import { heuristicIntent } from './intent.js';

describe('heuristicIntent', () => {
  it('classifies order-reference patterns as ORDER_DETAILS', () => {
    expect(heuristicIntent({ topic: 'My order #102345', body: 'Where is it?', fromHandle: 'jane@acme.com' })).toBe(
      'ORDER_DETAILS',
    );
  });

  it('classifies order-related terms as ORDER_DETAILS', () => {
    expect(
      heuristicIntent({ topic: 'Refund request', body: 'I want to return this item', fromHandle: 'jane@acme.com' }),
    ).toBe('ORDER_DETAILS');
    expect(
      heuristicIntent({ topic: 'Tracking', body: 'When will my shipment arrive?', fromHandle: 'jane@acme.com' }),
    ).toBe('ORDER_DETAILS');
  });

  it('classifies stock/price/variant questions as PRODUCT_INFO', () => {
    expect(
      heuristicIntent({ topic: 'Question', body: 'Is this in stock in size M?', fromHandle: 'jane@acme.com' }),
    ).toBe('PRODUCT_INFO');
    expect(
      heuristicIntent({ topic: 'Pricing', body: 'How much does this cost?', fromHandle: 'jane@acme.com' }),
    ).toBe('PRODUCT_INFO');
  });

  it('falls back to OTHER when nothing matches', () => {
    expect(
      heuristicIntent({ topic: 'Hello', body: 'Just wanted to say I love your store!', fromHandle: 'jane@acme.com' }),
    ).toBe('OTHER');
  });

  it('prioritises ORDER_DETAILS over PRODUCT_INFO when both lexicons match', () => {
    expect(
      heuristicIntent({
        topic: 'Order #12345',
        body: 'What price did I pay and is a replacement in stock?',
        fromHandle: 'jane@acme.com',
      }),
    ).toBe('ORDER_DETAILS');
  });
});

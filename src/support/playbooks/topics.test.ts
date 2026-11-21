import { describe, it, expect } from 'vitest';
import { heuristicTopics, topicToIntent, SUPPORT_TOPICS, type SupportTopic } from './topics.js';

const h = (topic: string, body: string) => heuristicTopics({ topic, body });

describe('heuristicTopics', () => {
  it('detects an order-status / WISMO question', () => {
    expect(h('', 'where is my order? any tracking?')).toContain('ORDER_STATUS');
  });

  it('detects a cancellation request', () => {
    expect(h('', 'please cancel my order #1234')).toContain('CANCEL_ORDER');
  });

  it('detects a delay complaint', () => {
    expect(h('', "it's been two weeks and my package still hasn't arrived")).toContain('ORDER_DELAYED');
  });

  it('detects a return/exchange request', () => {
    expect(h('Return', 'I want to return this and exchange for a larger size')).toContain('RETURN_EXCHANGE');
  });

  it('detects a refund request', () => {
    expect(h('', 'can I get a refund / my money back')).toContain('REFUND');
  });

  it('detects damaged/wrong/missing item', () => {
    expect(h('', 'the item arrived damaged and broken')).toContain('DAMAGED_WRONG_MISSING');
    expect(h('', 'you sent me the wrong item')).toContain('DAMAGED_WRONG_MISSING');
  });

  it('detects a reorder request', () => {
    expect(h('', 'I want to reorder the same thing I bought last month')).toContain('REORDER');
  });

  it('detects an address/edit change', () => {
    expect(h('', 'I need to change the shipping address on my order')).toContain('EDIT_ORDER');
  });

  it('detects stock/availability questions', () => {
    expect(h('', 'is the blue kurti back in stock?')).toContain('PRODUCT_AVAILABILITY');
  });

  it('detects pricing/discount questions', () => {
    expect(h('', 'my discount code is not working at checkout')).toContain('PRICING_DISCOUNT');
  });

  it('detects shipping info questions', () => {
    expect(h('', 'do you ship to Canada and how much is delivery?')).toContain('SHIPPING_INFO');
  });

  it('falls back to OTHER when nothing matches', () => {
    expect(h('', 'hello, just saying hi')).toEqual(['OTHER']);
  });

  it('returns at most two topics, most specific first', () => {
    const topics = h('', 'my order arrived damaged — is the blue one still in stock?');
    expect(topics.length).toBeLessThanOrEqual(2);
    expect(topics).toContain('DAMAGED_WRONG_MISSING');
  });

  it('never returns OTHER alongside a real topic', () => {
    const topics = h('', 'cancel my order please');
    expect(topics).not.toContain('OTHER');
  });
});

describe('topicToIntent', () => {
  it('maps every topic to a valid SupportIntent', () => {
    for (const t of SUPPORT_TOPICS) {
      expect(['ORDER_DETAILS', 'PRODUCT_INFO', 'OTHER']).toContain(topicToIntent(t as SupportTopic));
    }
  });

  it('maps order-lifecycle topics to ORDER_DETAILS', () => {
    expect(topicToIntent('CANCEL_ORDER')).toBe('ORDER_DETAILS');
    expect(topicToIntent('ORDER_STATUS')).toBe('ORDER_DETAILS');
    expect(topicToIntent('REFUND')).toBe('ORDER_DETAILS');
  });

  it('maps product/pricing topics to PRODUCT_INFO', () => {
    expect(topicToIntent('PRODUCT_AVAILABILITY')).toBe('PRODUCT_INFO');
    expect(topicToIntent('PRICING_DISCOUNT')).toBe('PRODUCT_INFO');
  });

  it('maps general topics to OTHER', () => {
    expect(topicToIntent('OTHER')).toBe('OTHER');
    expect(topicToIntent('WHOLESALE_B2B')).toBe('OTHER');
  });
});

import { describe, it, expect } from 'vitest';
import {
  registerChannelAdapter,
  getChannelAdapter,
  registerInboundSource,
  getInboundSource,
  listInboundSources,
  type ChannelAdapter,
  type InboundSource,
} from './channel-adapter.js';

function fakeAdapter(channelType: ChannelAdapter['channelType']): ChannelAdapter {
  return {
    channelType,
    styleHint: `style for ${channelType}`,
    usesSignature: false,
    buildReplyMeta: () => ({}),
    replyTopic: (topic) => topic,
    send: async () => ({ externalMessageId: 'ext_1' }),
  };
}

function fakeInboundSource(channelType: InboundSource['channelType']): InboundSource {
  return { channelType, processIngestJob: async () => false };
}

describe('channel adapter registry', () => {
  it('returns a registered adapter for its channelType', () => {
    const adapter = fakeAdapter('WHATSAPP');
    registerChannelAdapter(adapter);
    expect(getChannelAdapter('WHATSAPP')).toBe(adapter);
  });

  it('a later registration for the same channelType replaces the earlier one', () => {
    const first = fakeAdapter('INSTAGRAM_DM');
    const second = fakeAdapter('INSTAGRAM_DM');
    registerChannelAdapter(first);
    registerChannelAdapter(second);
    expect(getChannelAdapter('INSTAGRAM_DM')).toBe(second);
  });

  it('throws a descriptive error for an unregistered channelType', () => {
    // GMAIL is registered by src/index.ts at app startup, not by this test file —
    // in this isolated test module nothing has registered it yet.
    expect(() => getChannelAdapter('GMAIL')).toThrow(/No channel adapter registered for GMAIL/);
  });
});

describe('inbound source registry', () => {
  it('returns a registered inbound source for its channelType', () => {
    const source = fakeInboundSource('WHATSAPP');
    registerInboundSource(source);
    expect(getInboundSource('WHATSAPP')).toBe(source);
    expect(listInboundSources()).toContain(source);
  });

  it('a later registration for the same channelType replaces the earlier one', () => {
    const first = fakeInboundSource('INSTAGRAM_DM');
    const second = fakeInboundSource('INSTAGRAM_DM');
    registerInboundSource(first);
    registerInboundSource(second);
    expect(getInboundSource('INSTAGRAM_DM')).toBe(second);
  });

  it('returns undefined for an unregistered channelType (unlike the outbound registry, which throws)', () => {
    expect(getInboundSource('GMAIL')).toBeUndefined();
  });
});

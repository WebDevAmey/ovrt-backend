/**
 * Channel adapter contract + registry
 * ====================================
 * The seam that lets the support pipeline (triage → ingest → agent → send)
 * stay channel-agnostic. Each channel (Gmail, WhatsApp, Instagram DM later)
 * implements ChannelAdapter and registers itself once at startup.
 *
 * Webhook ingestion is deliberately NOT part of this interface — payload
 * shape, auth, and fetch differ too much per provider. The contract is the
 * OUTPUT: each channel's webhook normalizes its payload into a
 * NormalizedInboundMessage + ChannelSignals and calls the shared
 * triageInbound() → ingestInboundMessage() pipeline.
 */

import type { SupportChannelType } from '../../lib/generated/prisma/enums.js';

/** One inbound message, normalized to the shape the shared pipeline expects. */
export type NormalizedInboundMessage = {
  /** Provider-native conversation/thread id (Gmail threadId, WA chat id, IG thread id). */
  externalConversationId: string;
  /** Provider-native message id, used for idempotency. */
  externalMessageId: string;
  /** Subject/topic line, if the channel has one. */
  topic: string;
  customer: {
    /** Display name if the channel knows one. */
    displayName: string | null;
    /** Normalised handle (bare email, E.164 phone, IG username) — scopes lookups. */
    handle: string;
    /** Raw channel-native handle, for display/audit (e.g. `"Jane" <jane@acme.com>`). */
    rawHandle: string;
  };
  /** The address/account this message was sent TO (our connected account). */
  toHandle: string;
  /** Plain-text body. */
  body: string;
  /** Short preview, for inbox lists. */
  snippet: string;
  sentAt: Date | null;
  /** Adapter-owned metadata persisted on the message (e.g. Gmail headers for threading). */
  channelMeta: Record<string, unknown>;
};

/** Deterministic, channel-derived triage evidence (replaces Gmail-specific header checks). */
export type ChannelSignals = {
  /** Decisive "not support" — bulk/marketing/automated fingerprint. Short-circuits triage. */
  hardNegative: boolean;
  /** A single weak negative signal — penalizes but doesn't decide. */
  softNegative: boolean;
  /** This message is a reply within an existing conversation thread. */
  isReply: boolean;
  /** Human-readable signal names, for logging. */
  reasons: string[];
};

export type OutboundSendRequest = {
  organisationId: string;
  /** The connection sending this message. */
  connectionId: string;
  /** Provider-native conversation/thread id to send into. */
  externalConversationId: string;
  /** Recipient handle (customer's address/phone/IG username). */
  toHandle: string;
  /** Sender handle (our connected account). */
  fromHandle: string;
  /** Topic/subject for the outbound message (already adapted via replyTopic). */
  topic: string;
  /** Plain-text body to send. */
  body: string;
  /** Adapter-owned reply metadata from buildReplyMeta(), for threading. */
  replyMeta: Record<string, unknown>;
};

export interface ChannelAdapter {
  readonly channelType: SupportChannelType;
  /** Prompt hint describing how a reply on this channel should read (greeting/closing vs terse DM). */
  readonly styleHint: string;
  /** Whether the org's email signature should be appended to replies on this channel. */
  readonly usesSignature: boolean;
  /** Build channel-specific threading metadata (e.g. Gmail In-Reply-To/References) for a reply. */
  buildReplyMeta(inbound: {
    externalMessageId: string;
    channelMeta: Record<string, unknown>;
  }): Record<string, unknown>;
  /** Adapt a topic/subject for a reply (e.g. Gmail prepends "Re: "). */
  replyTopic(topic: string): string;
  /** Send an outbound message on this channel. */
  send(req: OutboundSendRequest): Promise<{ externalMessageId: string }>;
}

const registry = new Map<SupportChannelType, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  registry.set(adapter.channelType, adapter);
}

export function getChannelAdapter(channelType: SupportChannelType): ChannelAdapter {
  const adapter = registry.get(channelType);
  if (!adapter) {
    throw new Error(`No channel adapter registered for ${channelType}`);
  }
  return adapter;
}

/**
 * Inbound counterpart to ChannelAdapter — owns a channel's provider-native
 * delivery model (Gmail: a Pub/Sub notification + historyId batch fetch;
 * WhatsApp later: a webhook push carrying the full message). The delivery
 * shapes differ too much for a single normalized signature, so the seam is
 * "given one provider ingest job, drain and process it"; the channel-neutral
 * per-message work (triage → ingest → draft) is shared via
 * processInboundMessages() in inbound.ts, which every source calls.
 *
 * A channel only needs an InboundSource if it polls/drains a job table. A
 * push-with-full-payload channel can instead call processInboundMessages()
 * straight from its webhook and skip this seam entirely.
 */
export interface InboundSource {
  readonly channelType: SupportChannelType;
  /**
   * Claim and process the next available provider ingest job (or a specific
   * one by id). Returns true if a job was found and handled (so a drain loop
   * keeps going), false when the queue is empty.
   */
  processIngestJob(jobId?: string): Promise<boolean>;
}

const inboundRegistry = new Map<SupportChannelType, InboundSource>();

export function registerInboundSource(source: InboundSource): void {
  inboundRegistry.set(source.channelType, source);
}

export function getInboundSource(channelType: SupportChannelType): InboundSource | undefined {
  return inboundRegistry.get(channelType);
}

export function listInboundSources(): InboundSource[] {
  return [...inboundRegistry.values()];
}

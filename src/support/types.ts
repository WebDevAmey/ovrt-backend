/**
 * Channel-agnostic support agent contract
 * =======================================
 * The seam that lets one support brain serve Gmail today and WhatsApp / Instagram
 * DMs tomorrow. The agent core (agent.ts) speaks ONLY these types — it never
 * touches a SupportConversation row, a provider message id, RFC-2822 headers,
 * or Prisma. Each channel writes a thin adapter that:
 *
 *   1. maps its own conversation into a `ConversationContext`,
 *   2. calls `runSupportAgent(ctx, deps)`,
 *   3. maps the returned `AgentReply` back into a channel send / draft / escalation.
 *
 * The communication medium changes per channel; the agent stays the same.
 */

import type { ShopifyConnectInfo } from '../agents/shopify/credentials.js';
import type { InsightSentiment, InsightType, SupportIntent } from '../../lib/generated/prisma/enums.js';
import type { ActionOutcome, ActionPolicy, ActionType } from './actions/permissions.js';
import type { ActionEnv } from './actions/executors.js';

export type { SupportIntent };
export type { ActionOutcome, ActionPolicy };

/** Which surface the conversation arrived on. Drives which lookup tools the agent
 * gets (via intent-tools.ts) and lets a channel tweak tone (e.g. shorter for DMs)
 * without forking logic. */
export type SupportChannel = 'GMAIL' | 'WHATSAPP' | 'INSTAGRAM_DM';

/** Who the agent is talking to, resolved by the adapter from channel-native ids. */
export type CustomerIdentity = {
  /** Display name if the channel knows one (`Jane Doe`), else null. */
  name: string | null;
  /**
   * Normalised email, when the channel can supply one (Gmail always can; a DM
   * channel may not). This is what scopes order lookups — the adapter MUST pass
   * a clean, parsed email here, never a raw `From` header.
   */
  email: string | null;
  /** Normalised channel handle (bare email / E.164 phone / IG username) — used for lookups across channels. */
  handle: string;
  /** The raw channel-native handle, for logs (`"Jane" <jane@acme.com>`, a phone, an IG handle). */
  rawHandle: string;
};

export type ConversationRole = 'customer' | 'agent';

/** One turn of the conversation, oldest→newest, medium-stripped to plain text. */
export type ConversationTurn = {
  role: ConversationRole;
  /** The author as the channel framed it (for the transcript shown to the model). */
  author: string;
  text: string;
  at: Date | null;
};

/** Org voice + behavioural config, already loaded by the adapter (channel-neutral). */
export type SupportAgentConfig = {
  persona: string | null;
  signature: string | null;
  systemInstructions: string | null;
  /** Directives from matched rules, highest priority first. */
  directives: string[];
  /** Whether the org wants genuinely-sensitive messages handed to a human. */
  escalateOnComplex: boolean;
};

/** Everything the brain needs about one conversation, with zero channel coupling. */
export type ConversationContext = {
  organisationId: string;
  channel: SupportChannel;
  /** A short subject/topic line if the channel has one (email does; a DM may not). */
  topic: string | null;
  customer: CustomerIdentity;
  /** Full history oldest→newest, including the just-received customer message. */
  history: ConversationTurn[];
  config: SupportAgentConfig;
  /** Vertical routing bucket — drives which tools the agent gets (see intent-tools.ts). */
  intent: SupportIntent;
  /**
   * Pre-composed built-in playbook guidance for the detected topic(s)
   * (src/support/playbooks). The runner computes it from classifyTopics + the
   * merchant's action policy and passes it through; the prompt injects it as the
   * baseline workflow. Absent ⇒ no playbook block (e.g. a template-only reply).
   */
  playbookGuidance?: string;
};

/** What the agent decided. Distinct from any channel's send mechanics. */
export type AgentDisposition = 'answer' | 'clarify' | 'escalate';

/**
 * One actionable customer-support signal the agent extracted inline alongside
 * its reply (a quality complaint, wrong/damaged item, FAQ gap, feature/stock
 * request, shipping pain, or praise). The runner persists these to
 * CustomerInsight for a later store-improvement pass — they never affect the
 * reply itself. `snippet` is VERBATIM customer text (untrusted; must be fenced
 * before any future prompt use).
 */
export type AgentInsight = {
  type: InsightType;
  sentiment: InsightSentiment;
  summary: string;
  snippet: string;
  productHint?: string | null;
};

/** One grounding-tool outcome, surfaced for observability (did the lookup hit?). */
export type ToolEvent = {
  tool: string;
  rationale: string;
  rowCount?: number;
  error?: string;
  /** Present only for write-action tools: the authoritative result of the action. */
  action?: ActionOutcome;
};

/** The brain's output. The adapter decides how to deliver it on its channel. */
export type AgentReply = {
  disposition: AgentDisposition;
  /** Reply text for answer/clarify; null for escalate. Plain text, no signature. */
  body: string | null;
  /** Internal note for a teammate when escalating; null otherwise. */
  reviewReason: string | null;
  /** Observability. */
  modelId: string;
  usage: unknown;
  finishReason: string;
  toolCallCount: number;
  toolEvents: ToolEvent[];
  /** Set when output-guard.ts rejected the model's output and forced an escalation. */
  outputGuard?: { rejected: boolean; reason: string | null };
  /** Actionable signals to remember for store improvement; captured regardless of disposition. */
  insights: AgentInsight[];
  /**
   * The write-action the agent took this turn, if any (authoritative — from the
   * executor, not the model). The runner uses it for escalation/logging. Null
   * when the turn took no action.
   */
  action: ActionOutcome | null;
};

/**
 * Live store grounding the agent can use. Optional: a conversation with no
 * connected store still gets a (necessarily vaguer) reply. Built per-conversation
 * by the adapter so order lookups can be scoped to this customer.
 */
export type StoreContext = {
  conn: ShopifyConnectInfo;
  shopName: string;
  /** The customer's normalised email, used to scope order lookups for privacy. */
  customerEmail: string | null;
};

/** Injected dependencies, so the brain stays pure-ish and testable. */
export type SupportAgentDeps = {
  /** Resolved store grounding, or null when no store is connected. */
  store: StoreContext | null;
  signal?: AbortSignal;
  /**
   * Write-action capability for this conversation: the executor environment
   * (policy + Shopify ops + audit log, already scoped to the customer) and the
   * set of actions the agent may actually take. Omitted/empty ⇒ read-only.
   */
  actions?: { env: ActionEnv; performable: ReadonlySet<ActionType> };
};

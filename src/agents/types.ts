/**
 * Shared agent types and utilities
 * =================================
 * All agent implementations (research, shopify, web_search, playbook, and future agents)
 * share these types. Adding a new agent means:
 *   1. Creating a new folder under src/agents/<agent-name>/
 *   2. Implementing a runner that accepts EvidenceTask and returns Evidence
 *   3. Adding a case in src/agents/registry.ts
 *
 * The Evidence shape is the universal contract between agents and the
 * orchestrator's synthesis phase.
 */

import type { LanguageModelUsage, UIMessageChunk, UIMessageStreamWriter } from 'ai';
import type { Persona } from '../personas.js';
import type { LangfuseContext } from '../langfuse-tracing.js';

// ── Evidence types ────────────────────────────────────────────────────────────

export type EvidenceSource =
  | { type: 'shopify'; id: string; name: string; shopDomain: string }
  | { type: 'research' }
  | { type: 'web_search'; websites: Array<{ url: string; title: string }> }
  | { type: 'playbook'; name: string }
  | { type: 'unavailable' };

export type EvidenceRecord = {
  label: string;
  sql?: string;
  rowCount: number;
  rows: Array<Record<string, unknown>>;
};

/**
 * Normalised evidence returned by any specialised agent.
 * `summary` is always the primary human-readable finding.
 * `records` carry structured data (SQL results, API payloads, etc.) for agents
 * that produce it; empty for research-type evidence.
 */
export type Evidence = {
  question: string;
  source: EvidenceSource;
  records: EvidenceRecord[];
  summary: string;
  tokenUsage?: { input: number; output: number };
};

// ── Token tracking types ──────────────────────────────────────────────────────

export type TokenBreakdownEntry = {
  phase: 'planning' | 'evidence' | 'observation' | 'synthesis' | 'memory';
  agentType?: string;
  question?: string;
  inputTokens: number;
  outputTokens: number;
};

export function readTokens(usage: LanguageModelUsage | undefined): { input: number; output: number } {
  if (!usage) return { input: 0, output: 0 };
  const u = usage as unknown as {
    inputTokens?: number | { total?: number };
    outputTokens?: number | { total?: number };
  };
  const i = u.inputTokens;
  const o = u.outputTokens;
  const input = typeof i === 'number' ? i : typeof i?.total === 'number' ? i.total : 0;
  const output = typeof o === 'number' ? o : typeof o?.total === 'number' ? o.total : 0;
  return { input, output };
}

/**
 * Linkage info propagated from the orchestrator to sub-agents so AiTokenUsage
 * rows can be attributed back to the originating user / conversation / message.
 * organisationId is the only required field — sub-agents that don't have a
 * conversation context (background jobs) can omit the rest.
 */
export type AiUsageContext = {
  organisationId: string;
  userId?: string;
  conversationId?: string;
  messageId?: string;
};

export type EvidenceTaskType = 'research' | 'shopify' | 'web_search' | 'playbook';

export type EvidenceTask = {
  question: string;
  agentType: EvidenceTaskType;
  /**
   * Source id for the target agent:
   *   - shopify: ShopifyIntegration id (omit/null → first active store)
   *   - research: ignored
   */
  sourceId?: string | null;
  /** Override the agent's default MAX_TOOL_STEPS for this specific task. */
  maxSteps?: number;
};

// ── Agent runner context ──────────────────────────────────────────────────────

/**
 * Uniform context object passed to every agent runner.
 * Replaces the previous pattern of 7–8 positional arguments per agent function.
 * Adding a new field here automatically makes it available to all agents without
 * changing any function signatures.
 */
export type AgentRunnerContext = {
  orgId: string;
  orgSummary: string;
  providerModelId: string;
  writer: UIMessageStreamWriter | undefined;
  persona: Persona;
  usageCtx: AiUsageContext;
  signal?: AbortSignal;
  parentTrace?: LangfuseContext | null; // Optional Langfuse context for nested tracing
  /**
   * Rendered "store brief" — the store's own baselines and currently-flagged
   * signals (see src/orchestrator/store-intelligence.ts). Empty when the org has
   * no analyst data. Agents inject it so they can judge numbers against the
   * store's norms instead of answering cold.
   */
  storeBrief?: string;
};

/**
 * Self-describing agent definition used by the registry.
 * Each agent exports one of these; the registry, router, orchestrator manifest,
 * and planner routing rules all derive from it — no other files need editing
 * when a new agent is added.
 */
export type AgentDefinition = {
  type: EvidenceTaskType;
  /** Header line injected into buildResourceManifest for this agent. */
  manifestLine: string;
  /** True = only shown in the manifest when active DB sources of that kind exist. */
  requiresDbSource: boolean;
  /** One numbered rule injected into the planner ROUTING RULES block. */
  routingRule: string;
  run: (task: EvidenceTask, ctx: AgentRunnerContext) => Promise<Evidence>;
};

// ── Shared utilities ──────────────────────────────────────────────────────────

export function writeAgentStatus(
  writer: UIMessageStreamWriter | undefined,
  data: Record<string, unknown>,
): void {
  if (!writer) return;
  writer.write({ type: 'data-agent-status', data } as unknown as UIMessageChunk);
}

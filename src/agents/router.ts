/**
 * Agent Router
 * ============
 * Dispatches EvidenceTasks to the correct specialised agent using the registry.
 * No manual switch statement — the registry is the source of truth.
 *
 * Adding a new agent:
 *   1. Add its type to EvidenceTaskType in src/agents/types.ts
 *   2. Create src/agents/<name>/index.ts exporting a runner + AgentDefinition
 *   3. Register it in src/agents/registry.ts
 *   Done — routing, manifest, and planner rules update automatically.
 */

import { isOpenAIError, transformOpenAIError } from '../openai-errors.js';
import { AGENT_REGISTRY } from './registry.js';
import {
  writeAgentStatus,
  type Evidence,
  type EvidenceTask,
  type AiUsageContext,
  type AgentRunnerContext,
} from './types.js';

export {
  writeAgentStatus,
  type Evidence,
  type EvidenceTask,
  type EvidenceTaskType,
  type AiUsageContext,
  type AgentRunnerContext,
} from './types.js';

/**
 * Dispatches a single EvidenceTask to the appropriate agent and returns
 * normalised Evidence. Any agent failure is caught and returned as an
 * 'unavailable' source so the orchestrator can continue without crashing.
 */
export async function routeToAgent(
  task: EvidenceTask,
  ctx: AgentRunnerContext,
): Promise<Evidence> {
  try {
    const def =
      AGENT_REGISTRY.find((a) => a.type === task.agentType) ??
      AGENT_REGISTRY.find((a) => a.type === 'research')!;
    return await def.run(task, ctx);
  } catch (err) {
    // Re-throw AbortErrors so the orchestrator's abort logic can handle them.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const friendly = isOpenAIError(err) ? transformOpenAIError(err) : null;
    const msg = friendly?.message ?? (err instanceof Error ? err.message : String(err));
    console.error('[router] agent failed', { agentType: task.agentType, err: msg });
    return {
      question: task.question,
      source: { type: 'unavailable' },
      records: [],
      summary: `Evidence unavailable: ${msg}`,
    };
  }
}

// ── Synthesis formatting ──────────────────────────────────────────────────────

/**
 * Serialises Evidence to a compact token-efficient block for synthesis.
 * When records are present, raw data rows are passed without the worker's
 * prose interpretation — the synthesis LLM reasons directly from numbers.
 * When no records exist, a truncated summary snippet is used as fallback.
 */
export function formatEvidenceForSynthesis(e: Evidence, index: number): string {
  const src =
   e.source.type === 'shopify'
        ? `shopify:${e.source.name}`
        : e.source.type === 'research'
          ? 'research'
          : e.source.type === 'web_search'
            ? `web(${e.source.websites.length}src)`
            : e.source.type === 'playbook'
              ? `playbook:${e.source.name || 'unknown'}`
              : 'unavailable';

  const header = `[E${index + 1}|${src}] "${e.question}"`;

  if (e.records.length > 0) {
    const ROW_CAP = 10;
    const recordsText = e.records
      .map((r) => {
        const preview = r.rows.slice(0, ROW_CAP);
        const trunc = r.rowCount > ROW_CAP ? ` +${r.rowCount - ROW_CAP} omitted` : '';
        return `${r.label} (${r.rowCount} rows${trunc}):\n${JSON.stringify(preview)}`;
      })
      .join('\n');

    return `${header}\n${recordsText}`;
  }

  // No structured records — pass a summary snippet as fallback
  return `${header}\n${e.summary.slice(0, 500)}`;
}

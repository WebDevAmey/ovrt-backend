/**
 * Research Agent
 * ==============
 * Provides industry benchmarks, strategic frameworks, and expert context
 * when the question cannot be answered from a live database. Examples:
 *   - "What is a good churn rate for a SaaS business?"
 *   - "What should my CAC:LTV ratio be?"
 *   - "What are common reasons for activation drop-off?"
 *
 * The research agent does NOT invent internal operational data — it supplies
 * the external context that makes live data meaningful.
 */

import { generateText } from 'ai';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../../openai.js';
import {
  readTokens,
  writeAgentStatus,
  type Evidence,
  type EvidenceTask,
  type AgentRunnerContext,
  type AgentDefinition,
} from '../types.js';
import { logAiTokenUsage } from '../../ai-token-usage.js';
import { researchSystemPrompt } from './prompts.js';
import type { UIMessageStreamWriter } from 'ai';
import type { Persona } from '../../personas.js';
import { createAgentSpan, createGenerationSpan, endGenerationSpan, endSpan } from '../../langfuse-tracing.js';

export async function runResearchAgent(
  task: EvidenceTask,
  ctx: AgentRunnerContext,
): Promise<Evidence> {
  const { orgSummary, writer, persona, usageCtx, signal, parentTrace } = ctx;
  writeAgentStatus(writer, { phase: 'research-running', question: task.question });

  // Create Langfuse agent span
  const agentSpan = createAgentSpan(parentTrace || null, 'research', task.question, { persona });

  const researchModelId = process.env.RESEARCH_MODEL ?? 'gpt-4o-mini';
  const startedAt = new Date();

  // Create Langfuse generation span for LLM call (nested under agent span)
  const generationSpan = createGenerationSpan(parentTrace || null, 'research-generateText', researchModelId, {
    input: task.question,
  });

  try {
    const { text, usage, finishReason } = await generateText({
      model: openaiModel(researchModelId),
      system: researchSystemPrompt(orgSummary, persona),
      prompt: task.question,
      ...samplingFor(researchModelId, 0.4),
      ...reasoningOpts(researchModelId, 'low'),
      maxOutputTokens: maxTokensFor(researchModelId, 2048),
      abortSignal: signal,
    });

    const t = readTokens(usage);
    const latencyMs = Date.now() - startedAt.getTime();

    // End Langfuse generation span with token usage
    const summary = text?.trim()
      ? text
      : finishReason === 'length'
        ? '(Research answer was cut off before completion — the model ran out of output budget.)'
        : '(Research produced no answer — the model returned an empty response.)';

    endGenerationSpan(generationSpan, summary, {
      inputTokens: t.input,
      outputTokens: t.output,
    }, finishReason);

    logAiTokenUsage({
      ...usageCtx,
      modelName: researchModelId,
      feature: 'research',
      agentName: 'research',
      operation: 'answer',
      usage,
      finishReason,
      latencyMs,
      startedAt,
      metadata: { persona },
    });

    // End agent span
    endSpan(agentSpan, { summary: summary.substring(0, 200) });

    return {
      question: task.question,
      source: { type: 'research' },
      records: [],
      summary,
      tokenUsage: { input: t.input, output: t.output },
    };
  } catch (err) {
    endSpan(agentSpan, undefined, err as Error);
    throw err;
  }
}

export const researchAgentDef: AgentDefinition = {
  type: 'research',
  manifestLine: '[research] — use for any conceptual, framework, benchmark, or definition question.',
  requiresDbSource: false,
  routingRule: 'RESEARCH: agentType="research" — benchmarks, industry norms, strategy, definitions.',
  run: runResearchAgent,
};

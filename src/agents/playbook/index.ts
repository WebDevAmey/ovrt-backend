/**
 * Playbook Agent
 * ==============
 * Applies org-specific playbook skills to answer growth and strategy questions.
 * A "skill" is a curated knowledge document stored in the database — it encodes
 * proven tactics, frameworks, or SOPs specific to how this business operates.
 *
 * Flow:
 *   1. Fetch all active skill names + descriptions for the org.
 *   2. LLM selects the most relevant skill for the question.
 *   3. Fetch the full content of that skill.
 *   4. LLM applies the skill content to produce a concrete, actionable answer.
 */

import { generateText } from 'ai';
import { z } from 'zod';
import { Output } from 'ai';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../../openai.js';
import {
  readTokens,
  writeAgentStatus,
  type Evidence,
  type EvidenceTask,
  type AgentRunnerContext,
  type AgentDefinition,
} from '../types.js';
import { createAgentSpan, createGenerationSpan, endGenerationSpan, endSpan, type LangfuseContext } from '../../langfuse-tracing.js';
import { logAiTokenUsage } from '../../ai-token-usage.js';
import { playbookSelectionSystemPrompt, playbookApplicationSystemPrompt } from './prompts.js';
import { prisma } from '../../prisma.js';

const PLAYBOOK_MODEL = process.env.PLAYBOOK_MODEL ?? 'gpt-4o-mini';

const skillSelectionSchema = z.object({
  selectedSkillName: z.string().describe('The exact name of the chosen skill, or empty string if none is relevant.'),
  reasoning: z.string().describe('One sentence explaining why this skill best matches the question.'),
});

export async function runPlaybookAgent(
  task: EvidenceTask,
  ctx: AgentRunnerContext,
): Promise<Evidence> {
  const { orgSummary, providerModelId, writer, usageCtx, signal, persona, parentTrace } = ctx;

  // Create Langfuse agent and generation spans
  const agentSpan = createAgentSpan(parentTrace || null, 'playbook', task.question, { persona });
  const generationSpan = createGenerationSpan(parentTrace || null, 'playbook-generateText', providerModelId, {
    input: task.question,
  });

  writeAgentStatus(writer, { phase: 'playbook-fetching', question: task.question });

  // 1. Fetch all active playbooks (name + description only for selection step)
  const playbooks = await prisma.playbook.findMany({
    where: { isActive: true, type: 'CHAT' },
    select: { name: true, description: true },
    orderBy: { name: 'asc' },
  });

  if (playbooks.length === 0) {
    return {
      question: task.question,
      source: { type: 'playbook', name: '' },
      records: [],
      summary: 'No playbooks are configured yet. Add playbooks via the Playbook settings to enable this capability.',
    };
  }

  const playbookList = playbooks
    .map((p, i) => `${i + 1}. "${p.name}" — ${p.description}`)
    .join('\n');

  // 2. LLM selects the best playbook
  writeAgentStatus(writer, { phase: 'playbook-selecting', question: task.question });

  const selectionStartedAt = new Date();
  const selectionResult = await generateText({
    model: openaiModel(PLAYBOOK_MODEL),
    output: Output.object({ schema: skillSelectionSchema }),
    ...samplingFor(PLAYBOOK_MODEL, 0),
    ...reasoningOpts(PLAYBOOK_MODEL, 'minimal'),
    system: playbookSelectionSystemPrompt(orgSummary, playbookList),
    prompt: `Question: ${task.question}`,
    abortSignal: signal,
  });

  logAiTokenUsage({
    ...usageCtx,
    modelName: PLAYBOOK_MODEL,
    feature: 'playbook',
    agentName: 'playbook',
    operation: 'select',
    usage: selectionResult.usage,
    finishReason: selectionResult.finishReason,
    latencyMs: Date.now() - selectionStartedAt.getTime(),
    startedAt: selectionStartedAt,
  });

  // Accumulate tokens across BOTH LLM calls (select + apply) so the orchestrator's
  // per-turn breakdown reflects the agent's full cost, not just the apply step.
  const selectTokens = readTokens(selectionResult.usage);
  let totalInput = selectTokens.input;
  let totalOutput = selectTokens.output;

  const { selectedSkillName: selectedNameRaw, reasoning: selectionReasoning } = selectionResult.output;
  const selectedName = selectedNameRaw.trim();

  if (!selectedName) {
    return {
      question: task.question,
      source: { type: 'playbook', name: '' },
      records: [],
      summary: `No playbook matched this question. Available playbooks cover: ${playbooks.map((p) => p.name).join(', ')}.`,
      tokenUsage: { input: totalInput, output: totalOutput },
    };
  }

  // Resolve the model's choice against the actual list before hitting the DB.
  // The model may return a name with different casing/whitespace, or hallucinate
  // a name that isn't in the list at all — both should be treated as "no match"
  // (with the real options surfaced) rather than a misleading retrieval failure.
  const matched =
    playbooks.find((p) => p.name === selectedName) ??
    playbooks.find((p) => p.name.toLowerCase() === selectedName.toLowerCase());

  if (!matched) {
    return {
      question: task.question,
      source: { type: 'playbook', name: '' },
      records: [],
      summary: `No playbook matched this question. Available playbooks cover: ${playbooks.map((p) => p.name).join(', ')}.`,
      tokenUsage: { input: totalInput, output: totalOutput },
    };
  }

  // 3. Fetch the full content of the chosen playbook (using the canonical stored name)
  const playbook = await prisma.playbook.findFirst({
    where: { name: matched.name, isActive: true, type: 'CHAT' },
    select: { name: true, content: true },
  });

  if (!playbook) {
    return {
      question: task.question,
      source: { type: 'playbook', name: matched.name },
      records: [],
      summary: `Playbook "${matched.name}" was selected but could not be retrieved.`,
      tokenUsage: { input: totalInput, output: totalOutput },
    };
  }

  // 4. Apply the playbook content to generate an actionable answer
  writeAgentStatus(writer, { phase: 'playbook-applying', question: task.question, playbook: playbook.name });

  const applyStartedAt = new Date();
  const { text, usage, finishReason } = await generateText({
    model: openaiModel(providerModelId),
    ...samplingFor(providerModelId, 0.3),
    ...reasoningOpts(providerModelId, 'low'),
    maxOutputTokens: maxTokensFor(providerModelId, 2048),
    system: playbookApplicationSystemPrompt(orgSummary, playbook.name, playbook.content),
    prompt: task.question,
    abortSignal: signal,
  });

  const t = readTokens(usage);
  totalInput += t.input;
  totalOutput += t.output;

  logAiTokenUsage({
    ...usageCtx,
    modelName: providerModelId,
    feature: 'playbook',
    agentName: 'playbook',
    operation: 'apply',
    usage,
    finishReason,
    latencyMs: Date.now() - applyStartedAt.getTime(),
    startedAt: applyStartedAt,
    metadata: { playbookName: playbook.name, selectionReasoning },
  });

  // Guard against an empty/cut-off completion so synthesis never receives a blank
  // summary (mirrors the research/web-search agents' empty-output handling).
  const summary = text?.trim()
    ? text
    : finishReason === 'length'
      ? `(The answer from playbook "${playbook.name}" was cut off before completion — the model ran out of output budget.)`
      : `(Playbook "${playbook.name}" was selected but produced no answer — the model returned an empty response.)`;

  // End Langfuse spans
  endGenerationSpan(generationSpan, summary.substring(0, 500), {
    inputTokens: totalInput,
    outputTokens: totalOutput,
  }, finishReason);

  endSpan(agentSpan, { playbookName: playbook.name });

  return {
    question: task.question,
    source: { type: 'playbook', name: playbook.name },
    records: [],
    summary,
    tokenUsage: { input: totalInput, output: totalOutput },
  };
}

export const playbookAgentDef: AgentDefinition = {
  type: 'playbook',
  manifestLine: '[playbook] — use when deep business-specific knowledge, growth tactics, or internal SOPs are needed to answer the question.',
  requiresDbSource: false,
  routingRule: 'PLAYBOOK: agentType="playbook" — org-specific growth strategies, playbooks, operational SOPs, or business tactics that require internal knowledge beyond benchmarks.',
  run: runPlaybookAgent,
};

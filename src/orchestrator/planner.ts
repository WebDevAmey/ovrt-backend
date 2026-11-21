import { generateText, Output, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../openai.js';
import { AGENT_REGISTRY } from '../agents/registry.js';
import type { Persona } from '../personas.js';
import type { EvidenceTask, EvidenceTaskType } from '../agents/router.js';
import type { AnomalyContext } from '../agents/shopify-analyst/index.js';
import { readTokens } from '../agents/types.js';
import { logAiTokenUsage } from '../ai-token-usage.js';
import { writeStatus } from './types.js';
import { createGenerationSpan, endGenerationSpan, type LangfuseContext } from '../langfuse-tracing.js';

export const agentTypeValues = AGENT_REGISTRY.map((a) => a.type) as [EvidenceTaskType, ...EvidenceTaskType[]];

export const taskSchema = z.object({
  question: z.string().min(1),
  agentType: z.enum(agentTypeValues),
  sourceId: z.string().nullable(),
});

export const TASK_PER_ROUND_LIMIT = 3;

export const planSchema = z.object({
  needsInvestigation: z.boolean(),
  confidence: z.enum(['high', 'low']).describe(
    'high = the listed tasks will definitively answer the question, no follow-up gaps expected; low = uncertain, gaps may exist',
  ),
  tasks: z.array(taskSchema),
});

export function personaPlannerBias(persona: Persona): string {
  switch (persona) {
    case 'greenet':
      return 'ANALYTICAL LENS: Finance. When creating investigation tasks, prioritise evidence that reveals financial health — gross margin, net revenue, MRR/ARR trends, CAC payback period, unit economics, burn rate. Prefer tasks that compare current vs prior period for any financial metric.';
    case 'desert-blue':
      return 'ANALYTICAL LENS: Growth. When creating investigation tasks, prioritise evidence that reveals acquisition and retention performance — funnel conversion rates, cohort retention curves, activation milestones, channel performance, LTV segmentation. Prefer tasks that segment by acquisition source or cohort.';
    case 'idol-3':
    default:
      return 'ANALYTICAL LENS: Strategic operations. When creating investigation tasks, prioritise evidence that reveals key business levers — primary revenue drivers, customer concentration, growth rate vs prior period, retention signals. Prefer tasks that surface the metrics most likely to change a business decision.';
  }
}

export type PlannerResult = {
  initialTasks: EvidenceTask[];
  planConfidence: 'high' | 'low';
  inputTokens: number;
  outputTokens: number;
};

export async function runPlanner(
  userText: string,
  orgSummaryBlock: string,
  resourceManifest: string,
  storeSignalsBlock: string,
  persona: Persona,
  providerModelId: string,
  anomalyCtx: AnomalyContext | null,
  opportunityContextBlock: string,
  governanceBlock: string,
  isFollowUp: boolean,
  signal: AbortSignal | undefined,
  writer: UIMessageStreamWriter,
  orgId: string,
  userId: string,
  conversationId: string,
  messageId: string | undefined,
  plannerSpan?: any,
  rootContext?: LangfuseContext | null,
): Promise<PlannerResult> {
  writeStatus(writer, { phase: 'planning' });

  if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

  const anomalyPlannerHint = anomalyCtx
    ? `\n\nCONTEXT: This conversation is investigating a ${anomalyCtx.insightType} anomaly detected on ${anomalyCtx.date}. Route follow-up questions to the Shopify agent (sourceId: ${anomalyCtx.shopifySourceId ?? 'first active store'}).`
    : '';

  const orgSummaryAppend = orgSummaryBlock ? `\n\n${orgSummaryBlock}` : '';

  const followUpHint = isFollowUp
    ? '\n\nThis is a FOLLOW-UP in an ongoing conversation — earlier turns already gathered evidence. Re-investigate ONLY what this new question genuinely needs; do not re-run agents to re-fetch data the conversation likely already has. If the question is a refinement, reformatting, or clarification of a prior answer, prefer needsInvestigation=false or a single narrow task.'
    : '';

  const planStartedAt = new Date();

  // Create Langfuse generation span for LLM call (nested under planner span)
  const generationSpan = createGenerationSpan(rootContext || null, 'planner-generateText', providerModelId, {
    input: userText,
  });

  const plan = await generateText({
    model: openaiModel(providerModelId),
    output: Output.object({ schema: planSchema }),
    system: [
      'You are the master planning agent for a business intelligence platform.',
      'Decide if the question needs live evidence, then assign the right agent.',
      '',
      'CRITICAL CONSOLIDATION RULE:',
      'Each agent runs MANY tools internally in a single call (Shopify has 13 tools, Research synthesises freely). A single task like "top product analysis" already lets the Shopify agent fetch top sellers, refunds, AND inventory in one invocation.',
      'Default to ONE task. Only emit additional tasks when they require a DIFFERENT agent or a DIFFERENT source. Do NOT split one domain question into multiple same-agent + same-source tasks — that just duplicates system prompt + tool schemas and wastes tokens. Maximum 3 tasks total.',
      'Examples:',
      '  • "Top product analysis" → 1 shopify task (NOT 4 separate tasks for revenue/units/inventory/refunds).',
      '  • "Revenue this month vs benchmarks" → 2 tasks (1 shopify for revenue, 1 research for benchmarks).',
      '  • "How are we doing?" → 1 shopify task (the agent picks the right tools).',
      '',
      'ROUTING RULES:',
      ...AGENT_REGISTRY.map((a, i) => `${i + 1}. ${a.routingRule}`),
      `${AGENT_REGISTRY.length + 1}. NONE: needsInvestigation=false — ONLY for greetings, small talk, or pure reformatting of a prior reply.`,
      '',
      'Never return needsInvestigation=false for any metric or operational question.',
      '',
      'CONFIDENCE: Set confidence="high" when the listed tasks will definitively answer the question with no gaps expected. Set confidence="low" when multi-source answers may be incomplete or follow-up gaps are likely.',
      '',
      personaPlannerBias(persona),
      '',
      resourceManifest,
    ].join('\n') + orgSummaryAppend + storeSignalsBlock + anomalyPlannerHint + opportunityContextBlock + followUpHint + governanceBlock + '.',
    prompt: `User question:\n"""${userText}"""\n\nReturn the investigation plan.`,
    ...samplingFor(providerModelId, 0),
    ...reasoningOpts(providerModelId, 'minimal'),
    maxOutputTokens: maxTokensFor(providerModelId, 1024),
    abortSignal: signal,
  });

  const t = readTokens(plan.usage);
  const latencyMs = Date.now() - planStartedAt.getTime();

  // End Langfuse generation span with token usage
  const planConfidence = plan.output.confidence ?? 'low';
  const initialTasks = plan.output.needsInvestigation ? plan.output.tasks : [];
  const planOutput = JSON.stringify({ needsInvestigation: plan.output.needsInvestigation, taskCount: initialTasks.length, confidence: planConfidence });

  endGenerationSpan(generationSpan, planOutput, {
    inputTokens: t.input,
    outputTokens: t.output,
  }, plan.finishReason);

  logAiTokenUsage({
    organisationId: orgId,
    userId,
    conversationId,
    messageId,
    modelName: providerModelId,
    feature: 'orchestrator',
    operation: 'plan',
    usage: plan.usage,
    finishReason: plan.finishReason,
    latencyMs,
    startedAt: planStartedAt,
    metadata: { persona },
  });

  writeStatus(writer, { phase: 'planned', subQuestions: initialTasks.map((t) => t.question) });

  return { initialTasks, planConfidence, inputTokens: t.input, outputTokens: t.output };
}

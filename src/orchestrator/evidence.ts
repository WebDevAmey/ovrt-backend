import { generateText, Output, type UIMessageStreamWriter } from 'ai';
import { z } from 'zod';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../openai.js';
import { routeToAgent, type Evidence, type EvidenceTask, type AgentRunnerContext } from '../agents/router.js';
import type { Persona } from '../personas.js';
import { readTokens } from '../agents/types.js';
import { logAiTokenUsage } from '../ai-token-usage.js';
import { writeStatus } from './types.js';
import { taskSchema, TASK_PER_ROUND_LIMIT } from './planner.js';
import { createGenerationSpan, endGenerationSpan, type LangfuseContext } from '../langfuse-tracing.js';

export const MAX_EVIDENCE_ROUNDS = 2;

export const observationSchema = z.object({
  isComplete: z.boolean().describe(
    'True if the original question can be answered directly from the gathered evidence. Match scope to question: a count question is complete once the count is known; a comparison needs both values; a breakdown needs the breakdown data. Do NOT require trend data for a simple count, and do NOT require segment breakdown unless the question explicitly asks for drivers.',
  ),
  reasoning: z.string().describe(
    'One sentence explaining why the evidence is or is not complete.',
  ),
  additionalTasks: z.array(taskSchema).describe(
    'Follow-up tasks to fill critical gaps. Empty array if isComplete=true. Maximum 2. Never duplicate data already retrieved.',
  ),
});

export async function runTasks(
  tasks: EvidenceTask[],
  ctx: AgentRunnerContext,
  onTaskEvidence: (evidence: Evidence, task: EvidenceTask) => void,
): Promise<Evidence[]> {
  const limited = tasks.slice(0, TASK_PER_ROUND_LIMIT);
  return Promise.all(
    limited.map(async (task) => {
      if (ctx.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

      writeStatus(ctx.writer as UIMessageStreamWriter, {
        phase: 'worker-started',
        subQuestion: task.question,
        agentType: task.agentType,
      });

      const evidence = await routeToAgent(task, ctx);

      writeStatus(ctx.writer as UIMessageStreamWriter, {
        phase: 'worker-done',
        subQuestion: task.question,
        agentType: task.agentType,
        evidenceSummary: evidence.summary,
        source: evidence.source,
      });

      onTaskEvidence(evidence, task);
      return evidence;
    }),
  );
}

export async function runTasksSequentially(
  tasks: EvidenceTask[],
  ctx: AgentRunnerContext,
  onTaskEvidence: (evidence: Evidence, task: EvidenceTask) => void,
): Promise<Evidence[]> {
  const evidences: Evidence[] = [];
  for (const task of tasks.slice(0, TASK_PER_ROUND_LIMIT)) {
    if (ctx.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    writeStatus(ctx.writer as UIMessageStreamWriter, {
      phase: 'worker-started',
      subQuestion: task.question,
      agentType: task.agentType,
    });

    const evidence = await routeToAgent(task, ctx);

    writeStatus(ctx.writer as UIMessageStreamWriter, {
      phase: 'worker-done',
      subQuestion: task.question,
      agentType: task.agentType,
      evidenceSummary: evidence.summary,
      source: evidence.source,
    });

    onTaskEvidence(evidence, task);
    evidences.push(evidence);
  }
  return evidences;
}

export type ObservationResult = {
  isComplete: boolean;
  additionalTasks: EvidenceTask[];
  inputTokens: number;
  outputTokens: number;
};

export async function runObservation(
  userText: string,
  evidences: Evidence[],
  orgSummaryBlock: string,
  resourceManifest: string,
  persona: Persona,
  providerModelId: string, // Uses this for maxTokensFor, but overrides modelId
  round: number,
  signal: AbortSignal | undefined,
  writer: UIMessageStreamWriter,
  orgId: string,
  userId: string,
  conversationId: string,
  messageId: string | undefined,
  rootContext?: LangfuseContext | null,
): Promise<ObservationResult> {
  // Default the "is the evidence complete?" decision to the persona model. A
  // weak fallback (previously gpt-4o-mini) tended to call investigations
  // complete prematurely. OBSERVATION_MODEL can still override to trade quality
  // for cost/latency.
  const observationModelId = process.env.OBSERVATION_MODEL || providerModelId;
  writeStatus(writer, { phase: 'observing' });

  const evidenceSummaryText = evidences
    .map((e, i) => {
      const sourceLabel =
          e.source.type === 'shopify'
            ? `live Shopify store (${e.source.name})`
            : e.source.type === 'playbook'
              ? `internal playbook (${e.source.name || 'none matched'})`
              : e.source.type;
      const status =
        e.source.type === 'unavailable'
          ? 'FAILED — no data retrieved'
          : e.summary.slice(0, 300) + (e.summary.length > 300 ? '…' : '');
      return `Task ${i + 1}: "${e.question}" [${sourceLabel}]\n   ${status}`;
    })
    .join('\n\n');

  const observationStartedAt = new Date();
  const orgSummaryAppend = orgSummaryBlock ? `\n\n${orgSummaryBlock}` : '';

  // Create Langfuse generation span for observation LLM call
  const generationSpan = createGenerationSpan(rootContext || null, `observation-round-${round}`, providerModelId, {
    input: userText,
    evidenceCount: evidences.length,
  });

  const observation = await generateText({
    model: openaiModel(observationModelId),
    output: Output.object({ schema: observationSchema }),
    system: [
      'You are reviewing whether enough evidence has been gathered to answer the user\'s question.',
      '',
      'RULE: Match investigation scope to question complexity.',
      '  • Count/lookup ("how many X?", "what is X?") → complete once the value is retrieved.',
      '  • Trend ("is X growing?", "compare X") → complete once current + one prior period are retrieved.',
      '  • Breakdown ("what drives X?", "by segment") → complete once the breakdown is retrieved.',
      '',
      'Set isComplete=true if the question is answerable from the evidence — even if deeper analysis is possible.',
      'Do NOT require segment breakdown for a simple count question.',
      'Do NOT require trend data unless the question asks for trends.',
      'Do NOT spawn follow-ups that retrieve data in a slightly different form than what is already available.',
      'Maximum 2 additional tasks — only for genuinely missing data.',
      '',
      resourceManifest,
    ].join('\n') + orgSummaryAppend + '.',
    prompt: `Original question: "${userText}"\n\nEvidence gathered so far (${evidences.length} task(s)):\n\n${evidenceSummaryText}\n\nIs this sufficient? Return additionalTasks if a targeted follow-up is needed.`,
    ...samplingFor(providerModelId, 0),
    ...reasoningOpts(providerModelId, 'minimal'),
    maxOutputTokens: maxTokensFor(providerModelId, 512),
    abortSignal: signal,
  });

  const t = readTokens(observation.usage);
  const latencyMs = Date.now() - observationStartedAt.getTime();

  // End Langfuse generation span with token usage
  endGenerationSpan(generationSpan, JSON.stringify({ isComplete: observation.output.isComplete, additionalTasks: observation.output.additionalTasks.length }), {
    inputTokens: t.input,
    outputTokens: t.output,
  }, observation.finishReason);

  logAiTokenUsage({
    organisationId: orgId,
    userId,
    conversationId,
    messageId,
    modelName: observationModelId,
    feature: 'orchestrator',
    operation: 'observation',
    usage: observation.usage,
    finishReason: observation.finishReason,
    latencyMs,
    startedAt: observationStartedAt,
    metadata: { persona, round },
  });

  const obs = observation.output;
  console.log(`[orchestrator] observation round ${round}: isComplete=${obs.isComplete}, gaps="${obs.reasoning}", followUps=${obs.additionalTasks.length}`);

  if (!obs.isComplete && obs.additionalTasks.length > 0 && !signal?.aborted) {
    writeStatus(writer, {
      phase: 'follow-up-investigating',
      round,
      reasoning: obs.reasoning,
      subQuestions: obs.additionalTasks.map((t) => t.question),
    });
  }

  return {
    isComplete: obs.isComplete,
    additionalTasks: obs.additionalTasks,
    inputTokens: t.input,
    outputTokens: t.output,
  };
}

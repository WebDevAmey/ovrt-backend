import { streamText, convertToModelMessages, type UIMessage } from 'ai';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../openai.js';
import { formatEvidenceForSynthesis, type Evidence } from '../agents/router.js';
import type { Persona } from '../personas.js';
import { getPersonaPrompt } from '../personas.js';
import { buildAnomalySynthesisSystem, type AnomalyContext } from '../agents/shopify-analyst/index.js';
import { readTokens } from '../agents/types.js';
import { createGenerationSpan, endGenerationSpan, type LangfuseContext } from '../langfuse-tracing.js';

const MAX_OUTPUT_TOKENS = Number(process.env.CHAT_MAX_OUTPUT_TOKENS) || 4096;
const CHAT_MESSAGE_HISTORY = Number(process.env.CHAT_MESSAGE_HISTORY) || 0;

export type SynthesisResult = {
  text: string;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  usage: any;
};

export async function runSynthesis(
  messages: UIMessage[],
  evidences: Evidence[],
  persona: Persona,
  providerModelId: string,
  orgContextBlock: string,
  storeBriefBlock: string,
  memoryBlock: string,
  governanceBlock: string,
  isAnomalyFirstTurn: boolean,
  anomalyCtx: AnomalyContext | null,
  initialTasksLength: number,
  signal: AbortSignal | undefined,
  onStart: () => void,
  onFinish: (res: SynthesisResult) => void,
  onError: (err: unknown) => void,
  userId: string,
  conversationId: string,
  orgId: string,
  rootContext?: LangfuseContext | null,
) {
  const evidenceBlock =
    evidences.length === 0
      ? '(No investigation was run — answer from org context and general knowledge only. Do not fabricate operational data.)'
      : evidences.map((e, i) => formatEvidenceForSynthesis(e, i)).join('\n\n');

  const historyMessages =
    CHAT_MESSAGE_HISTORY > 0 ? messages.slice(-CHAT_MESSAGE_HISTORY) : messages;
  const modelMessages = await convertToModelMessages(historyMessages);

  const orgContextSection = orgContextBlock
    ? `\n\nOrganisation context:\n${orgContextBlock}`
    : '';
  const storeBriefSection = storeBriefBlock ? `\n\n${storeBriefBlock}` : '';

  let synthesisSystem: string;

  if (isAnomalyFirstTurn && anomalyCtx) {
    synthesisSystem =
      buildAnomalySynthesisSystem(anomalyCtx, persona, orgContextBlock, memoryBlock) +
      storeBriefSection +
      `\n${evidenceBlock}` +
      governanceBlock;
  } else if (evidences.length > 0 || initialTasksLength > 0) {
    const personaSystem = getPersonaPrompt(persona);
    synthesisSystem = `${personaSystem}${orgContextSection}${storeBriefSection}

Answer as an operator who knows THIS store. Ground every claim in the evidence and the store brief — never invent numbers. Judge each number against the store's own baselines in the brief (is this good or bad FOR THEM, not in the abstract). If a flagged signal in the brief is relevant to the question, raise it proactively. Lead with the single most important insight and its implication, bold the headline number, state the period-over-period delta, use markdown tables for comparisons, and format numbers with commas/currency/%. End with one concrete next action.${memoryBlock}${governanceBlock}

Evidence (compact rows — reason from these numbers directly):
${evidenceBlock}`;
  } else {
    const personaSystem = getPersonaPrompt(persona);
    synthesisSystem = `${personaSystem}${storeBriefSection}${memoryBlock}${governanceBlock}`;
  }

  const synthesisStartedAt = new Date();
  onStart();

  // Create Langfuse generation span for synthesis LLM call
  const generationSpan = createGenerationSpan(rootContext || null, 'synthesis-generateText', providerModelId, {
    evidenceCount: evidences.length,
  });

  return streamText({
    model: openaiModel(providerModelId),
    system: synthesisSystem,
    messages: modelMessages,
    ...samplingFor(providerModelId, 0.3),
    ...reasoningOpts(providerModelId, 'low'),
    maxOutputTokens: maxTokensFor(providerModelId, MAX_OUTPUT_TOKENS),
    abortSignal: signal,
    onFinish: ({ text, finishReason, usage }) => {
      const t = readTokens(usage);
      const latencyMs = Date.now() - synthesisStartedAt.getTime();

      // End Langfuse generation span
      endGenerationSpan(generationSpan, text.substring(0, 500), {
        inputTokens: t.input,
        outputTokens: t.output,
      }, finishReason);

      if (finishReason === 'length') {
        console.warn('[orchestrator] synthesis hit max_tokens — output truncated');
      }
      onFinish({
        text,
        finishReason,
        inputTokens: t.input,
        outputTokens: t.output,
        latencyMs,
        usage,
      });
    },
    onError: ({ error }) => {
      onError(error);
    },
  });
}

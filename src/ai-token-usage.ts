/**
 * AI Token Usage Logger
 * =====================
 * One row per LLM / embedding / etc. call we make, written to the AiTokenUsage
 * table. Every entrypoint here is fire-and-forget: the logger swallows its own
 * errors so a failed analytics write can never break a chat response or
 * background job.
 *
 * Per-row fields are mostly optional in the schema, so callers pass whatever
 * context they have — organisationId is the only required field. Sub-agent
 * calls typically only know organisationId + agent name; top-level orchestrator
 * calls also know userId, conversationId, and messageId.
 */
import { prisma } from './prisma.js';
import { AiServiceProvider, AiCallKind, AiCallStatus } from '../lib/generated/prisma/enums.js';

type AiUsageShape = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
};

export type LogAiTokenUsageInput = {
  // Ownership + linkage — set whichever are known at the call site.
  organisationId: string;
  userId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  jobId?: string | null;
  agentRunId?: string | null;

  // Service identity
  provider?: AiServiceProvider;
  serviceName?: string;
  modelName: string;
  modelVersion?: string;
  callKind?: AiCallKind;
  endpoint?: string;

  // Categorisation — used to slice analytics ("which feature/agent burns tokens?")
  feature?: string;
  agentName?: string;
  operation?: string;

  // Usage. Either pass the AI SDK `usage` object directly OR explicit counts.
  usage?: unknown;
  inputTokens?: number;
  outputTokens?: number;

  // Reliability / perf
  status?: AiCallStatus;
  finishReason?: string;
  latencyMs?: number;
  ttftMs?: number;
  toolCallCount?: number;
  retryCount?: number;
  errorCode?: string;
  errorMessage?: string;

  requestId?: string;
  traceId?: string;

  startedAt?: Date | null;
  completedAt?: Date | null;
  metadata?: Record<string, unknown>;
};

function readUsage(raw: unknown): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
} {
  if (!raw || typeof raw !== 'object') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }
  const u = raw as AiUsageShape;
  const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
  const outputTokens = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
  const cachedInputTokens =
    typeof u.inputTokenDetails?.cacheReadTokens === 'number'
      ? u.inputTokenDetails.cacheReadTokens
      : typeof u.cachedInputTokens === 'number'
        ? u.cachedInputTokens
        : 0;
  const cacheCreationTokens =
    typeof u.inputTokenDetails?.cacheWriteTokens === 'number'
      ? u.inputTokenDetails.cacheWriteTokens
      : 0;
  const reasoningTokens =
    typeof u.outputTokenDetails?.reasoningTokens === 'number'
      ? u.outputTokenDetails.reasoningTokens
      : typeof u.reasoningTokens === 'number'
        ? u.reasoningTokens
        : 0;
  return { inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens, reasoningTokens };
}

/**
 * Heuristic — every LLM call in this codebase currently routes through OpenAI
 * (see openaiModel in src/openai.ts). Sniff the model id for non-OpenAI prefixes
 * so this keeps working if/when we add other providers.
 */
function inferProvider(modelName: string): AiServiceProvider {
  const m = modelName.toLowerCase();
  if (m.startsWith('claude') || m.includes('anthropic')) return AiServiceProvider.ANTHROPIC;
  if (m.startsWith('gemini') || m.includes('google')) return AiServiceProvider.GOOGLE;
  if (m.startsWith('mistral')) return AiServiceProvider.MISTRAL;
  if (m.startsWith('grok') || m.startsWith('xai')) return AiServiceProvider.XAI;
  if (m.startsWith('deepseek')) return AiServiceProvider.DEEPSEEK;
  if (m.startsWith('command') || m.includes('cohere')) return AiServiceProvider.COHERE;
  return AiServiceProvider.OPENAI;
}

/**
 * Fire-and-forget log of one LLM/AI service call to AiTokenUsage.
 * Returns immediately; the write is async and errors are logged but never thrown.
 */
export function logAiTokenUsage(input: LogAiTokenUsageInput): void {
  const usageCounts = readUsage(input.usage);
  const inputTokens = input.inputTokens ?? usageCounts.inputTokens;
  const outputTokens = input.outputTokens ?? usageCounts.outputTokens;
  const cachedInputTokens = usageCounts.cachedInputTokens;
  const cacheCreationTokens = usageCounts.cacheCreationTokens;
  const reasoningTokens = usageCounts.reasoningTokens;
  const totalTokens = inputTokens + outputTokens;

  const provider = input.provider ?? inferProvider(input.modelName);
  const serviceName =
    input.serviceName ??
    (provider === AiServiceProvider.OPENAI ? 'openai' : provider.toLowerCase());

  prisma.aiTokenUsage
    .create({
      data: {
        organisationId: input.organisationId,
        userId: input.userId ?? undefined,
        conversationId: input.conversationId ?? undefined,
        messageId: input.messageId ?? undefined,
        jobId: input.jobId ?? undefined,
        agentRunId: input.agentRunId ?? undefined,
        provider,
        serviceName,
        modelName: input.modelName,
        modelVersion: input.modelVersion,
        callKind: input.callKind ?? AiCallKind.CHAT_COMPLETION,
        endpoint: input.endpoint,
        feature: input.feature,
        agentName: input.agentName,
        operation: input.operation,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationTokens,
        reasoningTokens,
        totalTokens,
        status: input.status ?? AiCallStatus.SUCCEEDED,
        finishReason: input.finishReason,
        latencyMs: input.latencyMs,
        ttftMs: input.ttftMs,
        toolCallCount: input.toolCallCount ?? 0,
        retryCount: input.retryCount ?? 0,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        requestId: input.requestId,
        traceId: input.traceId,
        startedAt: input.startedAt ?? undefined,
        completedAt: input.completedAt ?? new Date(),
        metadata: (input.metadata ?? {}) as object,
      },
    })
    .catch((err) => {
      console.error('[ai-token-usage] log failed', {
        feature: input.feature,
        operation: input.operation,
        modelName: input.modelName,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

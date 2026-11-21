import { Langfuse } from 'langfuse';

let langfuseClient: Langfuse | null = null;

export function initLangfuse(): Langfuse | null {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    console.warn('Langfuse keys not found, tracing disabled');
    return null;
  }

  const baseUrl = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
  console.log('[langfuse-tracing] Initializing with baseUrl:', baseUrl);

  langfuseClient = new Langfuse({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl,
    enabled: true,
  });

  console.log('[langfuse-tracing] Langfuse SDK initialized successfully');
  return langfuseClient;
}

export function getLangfuse(): Langfuse | null {
  return langfuseClient;
}

export async function flushLangfuse(): Promise<void> {
  if (langfuseClient) {
    await langfuseClient.flush();
  }
}

/**
 * Langfuse span context for proper parent-child nesting.
 * Contains both traceId (for the root) and observationId (for the parent span).
 */
export type LangfuseContext = {
  traceId: string;
  observationId?: string; // Parent observation ID for nesting
};

/**
 * Create a root trace for a chat request.
 * User message is the input, returns context for child spans.
 */
export function createChatTrace(
  userId: string,
  orgId: string,
  conversationId: string,
  messageId: string,
  persona: string,
  userMessage: string,
): LangfuseContext | null {
  if (!langfuseClient) {
    console.warn('[langfuse-tracing] Client is null, skipping trace creation');
    return null;
  }

  try {
    console.log('[langfuse-tracing] Creating chat trace for:', { userId, orgId, conversationId });
    // Create trace with user message as input
    const trace = langfuseClient.trace({
      name: 'chat-request',
      userId,
      sessionId: conversationId,
      tags: [`feature:orchestrator`, `persona:${persona}`],
      input: { userMessage },
      metadata: {
        orgId,
        messageId,
        persona,
      },
    });

    console.log('[langfuse-tracing] Chat trace created with ID:', trace.id);
    return { traceId: trace.id };
  } catch (err) {
    console.error('[langfuse-tracing] Error creating chat trace:', err);
    return null;
  }
}

/**
 * Create a span for a chat phase (planner, investigation, synthesis, etc).
 * Can be nested under a parent span via parentContext.observationId.
 */
export function createPhaseSpan(
  parentContext: LangfuseContext | null,
  phaseName: string,
  metadata?: Record<string, any>,
): any {
  if (!langfuseClient || !parentContext) return null;

  return langfuseClient.span({
    traceId: parentContext.traceId,
    parentObservationId: parentContext.observationId,
    name: phaseName,
    input: metadata?.input,
    metadata,
  });
}

/**
 * Create a span for an agent call.
 * Nested under parent (investigation or other) span.
 */
export function createAgentSpan(
  parentContext: LangfuseContext | null,
  agentType: string,
  question: string,
  metadata?: Record<string, any>,
): any {
  if (!langfuseClient || !parentContext) return null;

  return langfuseClient.span({
    traceId: parentContext.traceId,
    parentObservationId: parentContext.observationId,
    name: `agent-${agentType}`,
    input: { question },
    metadata: {
      agentType,
      ...metadata,
    },
  });
}

/**
 * Create a generation span for LLM calls.
 * Nested under parent span via observationId.
 */
export function createGenerationSpan(
  parentContext: LangfuseContext | null,
  operationName: string,
  model: string,
  metadata?: Record<string, any>,
): any {
  if (!langfuseClient || !parentContext) return null;

  return langfuseClient.generation({
    traceId: parentContext.traceId,
    parentObservationId: parentContext.observationId,
    name: operationName,
    model,
    input: metadata?.input,
    metadata,
  });
}

/**
 * End a generation span with LLM output and token usage.
 */
export function endGenerationSpan(
  generation: any,
  output: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  },
  finishReason?: string,
) {
  if (!generation) return;

  generation.end({
    output,
    usage: {
      input: usage.inputTokens || 0,
      output: usage.outputTokens || 0,
    },
    metadata: {
      finishReason,
    },
  });
}

/**
 * End a span with output and optional error.
 */
export function endSpan(
  span: any,
  output?: any,
  error?: Error,
) {
  if (!span) return;

  if (error) {
    span.end({
      output: null,
      metadata: {
        error: error.message,
        errorStack: error.stack,
      },
    });
  } else {
    span.end({
      output,
    });
  }
}

/**
 * Convert a span to a context for nesting child spans.
 * Extracts traceId and observationId from the span object.
 */
export function spanToContext(traceId: string, span: any): LangfuseContext | null {
  if (!span || !span.id) return null;

  return {
    traceId,
    observationId: span.id,
  };
}

/**
 * Create a span for an API/HTTP call (nested under agent).
 * These are tool calls or external API invocations.
 */
export function createAPICallSpan(
  parent: any,
  apiName: string,
  metadata?: Record<string, any>,
) {
  if (!parent) return null;

  return parent.span({
    name: apiName,
    metadata: {
      type: 'api_call',
      ...metadata,
    },
  });
}

/**
 * End an API call span.
 */
export function endAPICallSpan(
  span: ReturnType<typeof createAPICallSpan>,
  result?: any,
  error?: Error,
  latencyMs?: number,
) {
  if (!span) return;

  if (error) {
    span.end({
      output: null,
      metadata: {
        error: error.message,
        latencyMs,
      },
    });
  } else {
    span.end({
      output: result,
      metadata: {
        latencyMs,
      },
    });
  }
}

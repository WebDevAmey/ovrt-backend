import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('causal-backend');

export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * Start a new span with optional parent context.
 * Returns { span, context } for chaining.
 * Errors are logged but never thrown — returns mock span on failure.
 */
export function startSpan(
  name: string,
  attributes?: SpanAttributes,
  parentContext?: SpanContext
): { span: Span; context: SpanContext } {
  try {
    const span = tracer.startSpan(name, { attributes });

    return {
      span,
      context: {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
      },
    };
  } catch (err) {
    console.error('[telemetry] startSpan failed', { name, err: err instanceof Error ? err.message : String(err) });
    return {
      span: tracer.startSpan('fallback'),
      context: { traceId: '', spanId: '' },
    };
  }
}

/**
 * End a span with optional status and error message.
 * Errors are logged but never thrown.
 */
export function endSpan(
  span: Span | null | undefined,
  status?: 'success' | 'error',
  errorMessage?: string
): void {
  if (!span) return;

  try {
    if (status === 'error') {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  } catch (err) {
    console.error('[telemetry] endSpan failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Record token usage in span attributes.
 */
export function recordTokenUsage(span: Span | null | undefined, usage: TokenUsage): void {
  if (!span) return;

  try {
    span.setAttributes({
      'gen_ai.usage.input_tokens': usage.inputTokens,
      'gen_ai.usage.output_tokens': usage.outputTokens,
      ...(usage.cachedInputTokens && { 'gen_ai.usage.cache_read_input_tokens': usage.cachedInputTokens }),
      ...(usage.reasoningTokens && { 'gen_ai.usage.output_reasoning_tokens': usage.reasoningTokens }),
    });
  } catch (err) {
    console.error('[telemetry] recordTokenUsage failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Record a span event (milestone/checkpoint).
 */
export function recordSpanEvent(
  span: Span | null | undefined,
  eventName: string,
  attributes?: SpanAttributes
): void {
  if (!span) return;

  try {
    span.addEvent(eventName, attributes);
  } catch (err) {
    console.error('[telemetry] recordSpanEvent failed', { eventName, err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Record comprehensive agent call metadata in span.
 */
export function recordAgentCall(
  span: Span | null | undefined,
  agentType: string,
  modelId: string,
  question: string,
  usage: any,
  latencyMs: number,
  finishReason: string,
  status: 'success' | 'error',
  errorMessage?: string
): void {
  if (!span) return;

  try {
    const tokenUsage = readUsage(usage);

    span.setAttributes({
      'agent.type': agentType,
      'gen_ai.request.model': modelId,
      'gen_ai.response.finish_reason': finishReason,
      'gen_ai.usage.input_tokens': tokenUsage.inputTokens,
      'gen_ai.usage.output_tokens': tokenUsage.outputTokens,
      ...(tokenUsage.cachedInputTokens && { 'gen_ai.usage.cache_read_input_tokens': tokenUsage.cachedInputTokens }),
      ...(tokenUsage.reasoningTokens && { 'gen_ai.usage.output_reasoning_tokens': tokenUsage.reasoningTokens }),
    });

    recordSpanEvent(span, `agent-${status}`, {
      latencyMs,
      finishReason,
      ...(errorMessage && { errorMessage }),
    });

    endSpan(span, status, errorMessage);
  } catch (err) {
    console.error('[telemetry] recordAgentCall failed', { agentType, err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Parse usage object (from AI SDK or manual counts) into token breakdown.
 * Handles various formats (usage object, token counts, etc.).
 */
function readUsage(raw: unknown): TokenUsage {
  if (!raw || typeof raw !== 'object') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    };
  }

  const u = raw as any;
  const inputTokens = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
  const outputTokens = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
  const cachedInputTokens =
    typeof u.inputTokenDetails?.cacheReadTokens === 'number'
      ? u.inputTokenDetails.cacheReadTokens
      : typeof u.cachedInputTokens === 'number'
        ? u.cachedInputTokens
        : 0;
  const reasoningTokens =
    typeof u.outputTokenDetails?.reasoningTokens === 'number'
      ? u.outputTokenDetails.reasoningTokens
      : typeof u.reasoningTokens === 'number'
        ? u.reasoningTokens
        : 0;

  return { inputTokens, outputTokens, cachedInputTokens, reasoningTokens };
}

/**
 * Async wrapper: run fn within a span context, automatically end span on completion/error.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span, context: SpanContext) => Promise<T>
): Promise<T> {
  const { span, context: spanCtx } = startSpan(name, attributes);

  try {
    const result = await fn(span, spanCtx);
    endSpan(span, 'success');
    return result;
  } catch (err) {
    endSpan(span, 'error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Extract trace ID and span ID from current active span (for logging/correlation).
 * Returns null if no active span.
 */
export function getActiveSpanContext(): SpanContext | null {
  try {
    const span = trace.getActiveSpan();
    if (!span) return null;

    const spanCtx = span.spanContext();
    return {
      traceId: spanCtx.traceId,
      spanId: spanCtx.spanId,
    };
  } catch (err) {
    console.error('[telemetry] getActiveSpanContext failed', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

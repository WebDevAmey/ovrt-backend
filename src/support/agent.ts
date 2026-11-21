/**
 * Support agent brain (channel-agnostic, single-pass)
 * ====================================================
 * The one place that reasons about a customer conversation and decides how to
 * reply. It speaks only the channel-neutral contract in types.ts — given a
 * ConversationContext and resolved dependencies, it returns an AgentReply. It
 * never touches Gmail, Prisma, RFC-2822 headers, or any channel's send path;
 * those live in the per-channel adapters and src/support/runner.ts.
 *
 * SINGLE PASS (replaces the old two-phase ground+decide design): one
 * generateText call with BOTH read-only Shopify lookups (buildShopifyTools)
 * AND Output.object({ schema: replyOutputSchema }), bounded by
 * stepCountIs(MAX_TOOL_STEPS). This halves the tokens spent vs. sending the
 * full transcript twice. The conversation's classified `intent` is a hint the
 * runner uses for escalation/logging, NOT a tool gate — real messages are
 * multi-intent, so the model gets every tool and chooses per turn.
 *
 * The same structured output also carries `insights`: actionable customer
 * signals (quality complaints, FAQ gaps, praise, …) the runner persists for a
 * later store-improvement pass. They never affect the reply.
 *
 * RECOVERY PATH: on pinned ai@6, `experimental_output` can be missing if the
 * model ends on a tool call without emitting the structured object. If that
 * happens, ONE follow-up no-tools Output.object call is made — its prompt is
 * just the last customer message + topic + the serialized tool results from
 * the first call (NOT the full transcript), so the token cost stays bounded.
 *
 * Every reply is run through output-guard.ts before being returned; a
 * rejection is surfaced via `outputGuard` so the runner can convert it to an
 * escalation.
 */

import { generateText, Output, stepCountIs, type ToolSet } from 'ai';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../openai.js';
import { buildSupportPrompt } from './prompt.js';
import { replyOutputSchema, type ReplyOutput } from './reply-schema.js';
import { buildShopifyTools } from './tools/shopify.js';
import { buildSupportReadTools } from './tools/shopify-read.js';
import { buildSupportActionTools } from './tools/shopify-actions.js';
import { validateReply } from './output-guard.js';
import type { AgentInsight, AgentReply, ConversationContext, SupportAgentDeps, ToolEvent } from './types.js';
import type { ChannelAdapter } from './channel-adapter.js';

export function resolveAgentModelId(): string {
  return process.env.MODEL_SUPPORT_AGENT || process.env.MODEL_GMAIL_AGENT || process.env.CHAT_MODEL || 'gpt-4o-mini';
}

// Step budget: enough for several grounding lookups (order + tracking + policy/
// product, with a retry or two) plus the final structured output. The agent now
// has more read tools, so give it a little more headroom than the old single-lookup flow.
const MAX_TOOL_STEPS = Number(process.env.SUPPORT_AGENT_MAX_STEPS ?? process.env.GMAIL_AGENT_MAX_STEPS ?? '8');

/**
 * Run the support agent for one conversation. Pure with respect to channels:
 * the caller resolves `deps.store` (Shopify grounding) and maps the result back
 * onto its own channel.
 */
export async function runSupportAgent(
  ctx: ConversationContext,
  deps: SupportAgentDeps,
  adapterStyle: Pick<ChannelAdapter, 'styleHint' | 'usesSignature'>,
): Promise<AgentReply> {
  const modelId = resolveAgentModelId();

  const toolEvents: ToolEvent[] = [];
  let toolCallCount = 0;

  // Give the agent BOTH lookups whenever a store is connected, rather than
  // gating on the conversation's single classified intent. Real messages are
  // multi-intent ("my order arrived damaged — is the blue one still in stock?"),
  // and the model picks the relevant tool(s) per turn. `intent` remains a hint
  // used by the runner for escalation/logging, not a tool gate.
  let tools: ToolSet = {};
  let hasOrderTool = false;
  let hasProductTool = false;
  let hasActions = false;

  if (deps.store) {
    const onEvent = (e: ToolEvent) => toolEvents.push(e);
    tools = {
      ...buildShopifyTools({ store: deps.store, onEvent }),
      // Extra read-only grounding (tracking, store policies, discount validity)
      // the richer playbooks lean on.
      ...buildSupportReadTools({ store: deps.store, onEvent }),
    } as ToolSet;
    hasOrderTool = true;
    hasProductTool = true;

    // Gated write actions: only the tools the merchant enabled (∩ implemented).
    if (deps.actions && deps.actions.performable.size > 0) {
      tools = {
        ...tools,
        ...buildSupportActionTools({ env: deps.actions.env, performable: deps.actions.performable, onEvent }),
      } as ToolSet;
      hasActions = true;
    }
  }

  const { system, prompt } = buildSupportPrompt(ctx, {
    hasOrderTool,
    hasProductTool,
    hasActions,
    styleHint: adapterStyle.styleHint,
    usesSignature: adapterStyle.usesSignature,
  });

  const result = await generateText({
    model: openaiModel(modelId),
    system,
    prompt,
    tools,
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    output: Output.object({ schema: replyOutputSchema }),
    onStepFinish: (step) => {
      toolCallCount += step.toolCalls?.length ?? 0;
    },
    ...samplingFor(modelId, 0.3),
    ...reasoningOpts(modelId, 'low'),
    maxOutputTokens: maxTokensFor(modelId, 1024),
    abortSignal: deps.signal,
  });

  let output: ReplyOutput | undefined = result.experimental_output;
  let usage: unknown = result.usage;
  let finishReason = result.finishReason;

  if (!output) {
    // Recovery: the tool loop ended without emitting the structured object.
    // One bounded follow-up call: last customer message + topic + serialized
    // tool results — NOT the full transcript.
    const lastCustomerMessage = [...ctx.history].reverse().find((m) => m.role === 'customer');
    const toolResultsSummary = toolEvents.length
      ? toolEvents
          .map((e) =>
            e.error
              ? `${e.tool}: error — ${e.error}`
              : `${e.tool}: ${e.rowCount ?? 0} row(s) (${e.rationale})`,
          )
          .join('\n')
      : '(no tool calls)';

    const recoveryPrompt = [
      ctx.topic ? `Topic: ${ctx.topic}` : null,
      `Customer message: ${lastCustomerMessage?.text ?? '(none)'}`,
      '',
      'Tool lookup results from the previous step:',
      toolResultsSummary,
      '',
      'Write the final reply now: choose a disposition and, for answer/clarify, the reply body.',
    ]
      .filter((l): l is string => l !== null)
      .join('\n');

    const recovery = await generateText({
      model: openaiModel(modelId),
      system,
      prompt: recoveryPrompt,
      output: Output.object({ schema: replyOutputSchema }),
      ...samplingFor(modelId, 0.3),
      ...reasoningOpts(modelId, 'low'),
      maxOutputTokens: maxTokensFor(modelId, 1024),
      abortSignal: deps.signal,
    });

    output = recovery.experimental_output;
    usage = combineUsage(usage, recovery.usage);
    finishReason = recovery.finishReason;
  }

  const guard = validateReply(output);
  const escalated = output.disposition === 'escalate' || guard.rejected;

  // The authoritative action result for this turn: the LAST write-action a tool
  // executed (from the executor, never the model's self-report). The runner uses
  // it to escalate genuine failures and to log what happened.
  const action = [...toolEvents].reverse().find((e) => e.action)?.action ?? null;

  return {
    disposition: escalated ? 'escalate' : output.disposition,
    body: escalated ? null : output.body.trim(),
    reviewReason: guard.rejected
      ? `output-guard: ${guard.reason}`
      : output.disposition === 'escalate'
        ? output.reviewReason
        : null,
    modelId,
    usage,
    finishReason,
    toolCallCount,
    toolEvents,
    outputGuard: guard.rejected ? { rejected: true, reason: guard.reason } : undefined,
    // Captured regardless of disposition — escalated messages (severe complaints,
    // legal threats) are exactly the high-signal ones worth remembering.
    insights: toAgentInsights(output.insights),
    action,
  };
}

/** Map the model's structured insights to the channel-neutral AgentInsight type. */
function toAgentInsights(insights: ReplyOutput['insights'] | undefined): AgentInsight[] {
  if (!insights?.length) return [];
  return insights
    .filter((i) => i.snippet.trim() && i.summary.trim())
    .map((i) => ({
      type: i.type,
      sentiment: i.sentiment,
      summary: i.summary.trim(),
      snippet: i.snippet.trim(),
      productHint: i.productHint ?? null,
    }));
}

/** Best-effort merge of two AI-SDK usage objects (fields are optional/loose). */
function combineUsage(a: unknown, b: unknown): unknown {
  const ua = (a ?? {}) as Record<string, number | undefined>;
  const ub = (b ?? {}) as Record<string, number | undefined>;
  if (!a) return b;
  const keys = new Set([...Object.keys(ua), ...Object.keys(ub)]);
  const merged: Record<string, number> = {};
  for (const k of keys) {
    const va = typeof ua[k] === 'number' ? ua[k]! : 0;
    const vb = typeof ub[k] === 'number' ? ub[k]! : 0;
    merged[k] = va + vb;
  }
  return merged;
}

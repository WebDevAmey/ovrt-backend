/**
 * Support agent job runner (channel-agnostic)
 * ============================================
 * Processes one SupportAgentJob: load the conversation + history + config,
 * match rules, route by intent, draft a reply (or escalate / use a template),
 * and persist the OUTBOUND SupportMessage. Mirrors src/analyst/runner.ts's
 * state machine + error handling.
 *
 * ALL INTENTS REACH THE AGENT: there is no OTHER dead-end. Every kept message
 * (order, product, review, policy/FAQ, general) gets a drafted reply with both
 * read-only Shopify lookups available; the agent self-escalates only genuinely
 * sensitive cases. The org's fallbackBehavior (draft/escalate/skip) still governs
 * what happens when no rule matched, and an ESCALATE rule still short-circuits.
 *
 * INSIGHT CAPTURE: after a successful run, any actionable signals the agent
 * emitted (CustomerInsight rows) are persisted best-effort — never failing the
 * reply if the write errors (e.g. the table is absent in a given environment).
 *
 * THIS PASS DRAFTS ONLY — it never sends. The OUTBOUND message's status is the
 * seam for sender-worker.ts:
 *   AUTO_SEND → status APPROVED, conversation READY_TO_SEND (sender picks it up)
 *   DRAFT     → status DRAFT,    conversation AWAITING_APPROVAL (human approves first)
 *   escalate  → no message,      conversation NEEDS_HUMAN
 */

import { prisma } from '../prisma.js';
import { logAiTokenUsage } from '../ai-token-usage.js';
import { loadAgentConfig, applyAgentOverrides } from './config.js';
import { matchRules } from './rules.js';
import { loadStoreContext } from './store-context.js';
import { runSupportAgent } from './agent.js';
import { getChannelAdapter } from './channel-adapter.js';
import { classifyTopics } from './playbooks/topics.js';
import { selectPlaybooks } from './playbooks/registry.js';
import { parseActionPolicy, enabledActions, type ActionType } from './actions/permissions.js';
import { buildShopifyActionOps } from './actions/shopify-ops.js';
import { prismaActionLog } from './actions/action-log.js';
import type { AgentInsight, ConversationContext, ConversationTurn, CustomerIdentity, SupportAgentDeps } from './types.js';

// Write actions implemented so far (Phase B safe trio). Returns/refunds land in a
// later pass; until then they are never "performable" even if the merchant enables them.
const WIRED_ACTIONS: ActionType[] = ['cancelOrder', 'editAddress', 'reorder'];

export async function runSupportAgentJob(jobId: string): Promise<void> {
  const startedAt = new Date();
  // Bug #2 fix: do not unconditionally set RUNNING here — the caller (queue-worker
  // or worker.ts task-runner) already performed an atomic QUEUED→RUNNING transition
  // with a status precondition. An unconditional update here would silently succeed
  // even if two callers raced, allowing both to proceed and create duplicate drafts.
  // We only read the job row; callers are responsible for the status transition.
  const job = await prisma.supportAgentJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { id: true, organisationId: true, conversationId: true },
  });

  try {
    const conversation = await prisma.supportConversation.findUnique({
      where: { id: job.conversationId },
      include: {
        connection: true,
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conversation) throw new Error(`conversation ${job.conversationId} not found`);

    let config = await loadAgentConfig(job.organisationId);
    if (!config || config.mode === 'OFF') {
      await markSucceeded(jobId);
      console.log(`[support-agent] job ${jobId}: agent OFF/unconfigured — skipped`);
      return;
    }
    config = applyAgentOverrides(config, conversation.connection.agentOverrides);
    if (config.mode === 'OFF') {
      await markSucceeded(jobId);
      console.log(`[support-agent] job ${jobId}: agent OFF (connection override) — skipped`);
      return;
    }

    // The triggering inbound message is the latest INBOUND in the conversation.
    const lastInbound = [...conversation.messages].reverse().find((m) => m.direction === 'INBOUND');
    if (!lastInbound) {
      await markSucceeded(jobId);
      console.log(`[support-agent] job ${jobId}: no inbound message — skipped`);
      return;
    }

    const ruleResult = matchRules(
      { subject: lastInbound.subject, body: lastInbound.body, from: lastInbound.fromHandle },
      config.rules,
    );

    // Escalation: an ESCALATE rule, or low-confidence classification when the
    // org opted into escalating those.
    //
    // BUT: lowConfidence reflects the *triage* classifier's uncertainty about
    // whether this was a support message at all (e.g. "I want to know about my
    // order" has no order number, so it lands in the ambiguous band). Once the
    // intent gate has confidently routed the message to ORDER_DETAILS or
    // PRODUCT_INFO, the agent has relevant lookup tools and can attempt a reply
    // (asking for an order number/email if needed) — it can still self-escalate
    // for genuinely sensitive cases via its own 'escalate' disposition, below.
    // Similarly, when a DIRECTIVE rule matched, the org has explicitly told the
    // agent how to handle this kind of message, which also suppresses the
    // low-confidence escalation.
    const hasDirective = ruleResult.directives.length > 0;
    const hasRoutedIntent = conversation.intent === 'ORDER_DETAILS' || conversation.intent === 'PRODUCT_INFO';
    const shouldEscalate =
      ruleResult.escalate !== null ||
      (config.escalateOnLowConfidence && lastInbound.lowConfidence === true && !hasDirective && !hasRoutedIntent) ||
      (ruleResult.matched.length === 0 && config.fallbackBehavior === 'escalate');

    if (shouldEscalate) {
      await prisma.supportConversation.update({
        where: { id: conversation.id },
        data: { status: 'NEEDS_HUMAN' },
      });
      await markSucceeded(jobId);
      console.log(
        `[support-agent] conversation ${conversation.id}: escalated to human ` +
          `(${ruleResult.escalate ? `rule:${ruleResult.escalate.name}` : 'low-conf/fallback'})`,
      );
      return;
    }

    // Fallback "skip": no rule matched and the org chose not to draft generically.
    if (ruleResult.matched.length === 0 && config.fallbackBehavior === 'skip') {
      await markSucceeded(jobId);
      console.log(`[support-agent] conversation ${conversation.id}: no rule matched, fallback=skip`);
      return;
    }

    const adapter = getChannelAdapter(conversation.channelType);

    // Build the reply body: a TEMPLATE rule is verbatim; otherwise the LLM drafts.
    let body: string;
    let generatedByModel: string | null = null;
    let outputGuardReason: string | null = null;
    if (ruleResult.template && ruleResult.template.responseTemplate) {
      body = ruleResult.template.responseTemplate;
      console.log(
        `[support-agent] conversation ${conversation.id}: using template rule "${ruleResult.template.name}"`,
      );
    } else {
      const customer: CustomerIdentity = {
        name: conversation.customerName,
        email: conversation.channelType === 'GMAIL' ? conversation.customerHandle : null,
        handle: conversation.customerHandle,
        rawHandle: conversation.customerRawHandle,
      };

      const history: ConversationTurn[] = conversation.messages.map((mm) => ({
        role: mm.direction === 'INBOUND' ? 'customer' : 'agent',
        author: mm.fromHandle,
        text: mm.body,
        at: mm.sentAt,
      }));

      const store = await loadStoreContext(job.organisationId, customer.email);

      // Classify the message into fine-grained topic(s) and compose the built-in
      // playbook guidance for them — the baseline "structured workflow" that makes
      // the agent robust even with zero merchant rules.
      const topicSignals = await classifyTopics({ topic: lastInbound.subject, body: lastInbound.body });

      // Resolve which write actions the agent may actually take: merchant-enabled
      // ∩ implemented, and only when a store is connected to act on.
      const actionPolicy = parseActionPolicy(config.actionPermissions);
      const performable = new Set<ActionType>(
        store ? enabledActions(actionPolicy).filter((a) => WIRED_ACTIONS.includes(a)) : [],
      );
      const playbookGuidance = selectPlaybooks(topicSignals.topics, performable);

      let actions: SupportAgentDeps['actions'];
      if (store && performable.size > 0) {
        actions = {
          env: {
            organisationId: job.organisationId,
            conversationId: conversation.id,
            customerEmail: customer.email,
            policy: actionPolicy,
            ops: buildShopifyActionOps(store.conn),
            log: prismaActionLog,
          },
          performable,
        };
      }

      const ctx: ConversationContext = {
        organisationId: job.organisationId,
        channel: conversation.channelType,
        topic: conversation.subject,
        customer,
        history,
        config: {
          persona: config.persona,
          signature: config.signature,
          systemInstructions: config.systemInstructions,
          directives: ruleResult.directives,
          escalateOnComplex: config.escalateOnComplex,
        },
        intent: conversation.intent,
        playbookGuidance,
      };

      const result = await runSupportAgent(ctx, { store, actions }, adapter);
      generatedByModel = result.modelId;
      outputGuardReason = result.outputGuard?.reason ?? null;

      logAiTokenUsage({
        organisationId: job.organisationId,
        feature: 'support-agent',
        agentName: 'support-agent',
        operation: 'draft-reply',
        modelName: result.modelId,
        usage: result.usage,
        finishReason: result.finishReason,
        latencyMs: Date.now() - startedAt.getTime(),
        startedAt,
        toolCallCount: result.toolCallCount,
        metadata: {
          conversationId: conversation.id,
          channelType: conversation.channelType,
          intent: conversation.intent,
          matchedRuleIds: ruleResult.matched.map((r) => r.id),
          disposition: result.disposition,
          outputGuardRejected: result.outputGuard?.rejected ?? false,
        },
      });

      // Observability: record the model's disposition and its grounding effort
      // on every run, so over-escalation / brittle lookups are tunable from logs
      // rather than guesswork.
      const toolSummary = result.toolEvents
        .map((e) => `${e.tool}(${e.error ? `err:${e.error}` : `rows:${e.rowCount ?? '?'}`})`)
        .join(' ');
      console.log(
        `[support-agent] conversation ${conversation.id}: topics=[${topicSignals.topics.join(',')}]` +
          (topicSignals.sensitive ? ' sensitive' : '') +
          (topicSignals.manipulation ? ' manipulation' : '') +
          ` disposition=${result.disposition} ` +
          (result.action ? `action=${result.action.type}:${result.action.status} ` : '') +
          `toolCalls=${result.toolCallCount}` +
          (toolSummary ? ` tools=[${toolSummary}]` : ' tools=[none]') +
          (result.disposition === 'escalate' ? ` reviewReason=${result.reviewReason ?? 'none'}` : ''),
      );

      // Persist any actionable customer signals (store-improvement memory).
      // Independent of disposition — escalated complaints are high-signal too.
      // Best-effort: a write failure must never break the customer reply.
      await persistInsights(job.organisationId, conversation.id, lastInbound.id, result.insights);

      // A write action was ATTEMPTED and failed (Shopify mutation errored). Hand
      // to a human regardless of what the model drafted — we never auto-send a
      // reply about a failed cancel/refund/edit. (proposed/ineligible/not_permitted
      // are normal and flow through the regular disposition logic below.)
      if (result.action?.status === 'failed') {
        await prisma.supportConversation.update({
          where: { id: conversation.id },
          data: { status: 'NEEDS_HUMAN' },
        });
        await markSucceeded(jobId);
        console.log(
          `[support-agent] conversation ${conversation.id}: action ${result.action.type} FAILED — NEEDS_HUMAN ` +
            `(${result.action.summary})`,
        );
        return;
      }

      // The model judged this message too sensitive/risky to auto-answer (or
      // output-guard rejected the body as a leak). No draft is created — the
      // conversation is handed to a human, even under AUTO_SEND. This overrides
      // the configured mode for this message only.
      // Note: a "clarify" disposition is NOT an escalation — it still drafts a
      // reply (one that asks the customer for a missing detail) and sends as normal.
      if (result.disposition === 'escalate' && (config.escalateOnComplex || result.outputGuard?.rejected)) {
        await prisma.supportConversation.update({
          where: { id: conversation.id },
          data: { status: 'NEEDS_HUMAN' },
        });
        await markSucceeded(jobId);
        console.log(
          `[support-agent] conversation ${conversation.id}: escalated to human ` +
            `(${result.outputGuard?.rejected ? `output-guard: ${result.outputGuard.reason}` : `sensitive: ${result.reviewReason ?? 'no reason given'}`})`,
        );
        return;
      }

      if (result.disposition === 'escalate') {
        // Escalated but org doesn't escalate-on-complex and the guard didn't
        // reject — fall through to NEEDS_HUMAN anyway; there's no body to send.
        await prisma.supportConversation.update({
          where: { id: conversation.id },
          data: { status: 'NEEDS_HUMAN' },
        });
        await markSucceeded(jobId);
        console.log(
          `[support-agent] conversation ${conversation.id}: model escalated, no draft created — NEEDS_HUMAN`,
        );
        return;
      }

      body = result.body ?? '';
    }

    // Persist the OUTBOUND draft. AUTO_SEND pre-approves it; DRAFT awaits a human.
    const autoSend = config.mode === 'AUTO_SEND';
    const replyMeta = adapter.buildReplyMeta({
      externalMessageId: lastInbound.externalMessageId ?? '',
      channelMeta: lastInbound.channelMeta as Record<string, unknown>,
    });

    await prisma.supportMessage.create({
      data: {
        conversationId: conversation.id,
        organisationId: job.organisationId,
        direction: 'OUTBOUND',
        status: autoSend ? 'APPROVED' : 'DRAFT',
        fromHandle: conversation.connection.externalAccountId,
        toHandle: conversation.customerRawHandle,
        subject: adapter.replyTopic(conversation.subject),
        snippet: body.slice(0, 200),
        body,
        channelMeta: replyMeta as object,
        generatedByModel,
        matchedRuleIds: ruleResult.matched.map((r) => r.id),
        agentJobId: jobId,
        ...(outputGuardReason ? { classReasons: [`output-guard: ${outputGuardReason}`] } : {}),
      },
    });

    await prisma.supportConversation.update({
      where: { id: conversation.id },
      data: {
        status: autoSend ? 'READY_TO_SEND' : 'AWAITING_APPROVAL',
        lastOutboundAt: new Date(),
      },
    });

    await markSucceeded(jobId);
    console.log(
      `[support-agent] conversation ${conversation.id}: drafted reply ` +
        `(${autoSend ? 'APPROVED/READY_TO_SEND' : 'DRAFT/AWAITING_APPROVAL'})`,
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[support-agent] job ${jobId} failed: ${errorMsg}`, err);
    await prisma.supportAgentJob
      .update({
        where: { id: jobId },
        data: { status: 'FAILED', completedAt: new Date(), error: errorMsg.slice(0, 500) },
      })
      .catch((e) => console.error('[support-agent] failed to mark job FAILED:', e));
    throw err; // let the task-runner's retry policy see it
  }
}

async function markSucceeded(jobId: string): Promise<void> {
  await prisma.supportAgentJob.update({
    where: { id: jobId },
    data: { status: 'SUCCEEDED', completedAt: new Date() },
  });
}

/**
 * Persist the agent's captured customer insights (store-improvement memory).
 * Best-effort: any failure (e.g. the CustomerInsight table is absent in this
 * environment) is logged and swallowed so it can never break a customer reply.
 * `snippet` is verbatim customer text — a future consumer MUST fence it before
 * using it in any prompt.
 */
async function persistInsights(
  organisationId: string,
  conversationId: string,
  messageId: string,
  insights: AgentInsight[],
): Promise<void> {
  if (!insights.length) return;
  try {
    await prisma.customerInsight.createMany({
      data: insights.map((ins) => ({
        organisationId,
        conversationId,
        messageId,
        type: ins.type,
        sentiment: ins.sentiment,
        summary: ins.summary.slice(0, 2000),
        snippet: ins.snippet.slice(0, 2000),
        productHint: ins.productHint ?? null,
      })),
    });
    console.log(`[support-agent] conversation ${conversationId}: captured ${insights.length} insight(s)`);
  } catch (e) {
    console.warn(
      `[support-agent] conversation ${conversationId}: insight persist failed (non-fatal): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

import { registerTelemetry } from './telemetry.js';
registerTelemetry();

import { initLangfuse, flushLangfuse } from './langfuse-tracing.js';
initLangfuse();

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { JsonToSseTransformStream, type UIMessage } from 'ai';
import { verifyServiceToken } from './service-token.js';
import { runOrchestrator, type ResourceUsed } from './orchestrator/index.js';
import { postChatFinish, recordChatAgentRun } from './webhook.js';
import { checkAndConsumeMessage } from './rate-limit.js';
import { resolvePersona } from './personas.js';
import { analyst } from './analyst/index.js';
import {
  startAnalystRunner,
  startAnalystScheduler,
  reapStaleAnalystJobs,
  shutdownAnalyst,
} from './analyst/worker.js';
import {
  marketIntelligence,
  startMarketIntelligenceWorker,
  shutdownMarketIntelligenceWorker,
} from './market-intelligence/index.js';
import { gmail } from './gmail/routes.js';
import { renewGmailWatches } from './gmail/renew.js';
import { gmailAdapter } from './gmail/adapter.js';
import { gmailInboundSource } from './gmail/inbound.js';
import { whatsapp } from './whatsapp/routes.js';
import { whatsappAdapter } from './whatsapp/adapter.js';
import { content } from './content/routes.js';
import { startContentWorker, shutdownContentWorker } from './content/worker.js';
import { revenueLoss } from './revenue-loss/routes.js';
import { shopifyData } from './shopify-data/routes.js';
import { support } from './support/routes.js';
import { registerChannelAdapter, registerInboundSource } from './support/channel-adapter.js';
import {
  startSupportAgentWorker,
  shutdownSupportAgentWorker,
  reapStaleSupportAgentJobs,
} from './support/worker.js';
import {
  startSupportSenderWorker,
  shutdownSupportSenderWorker,
} from './support/sender-worker.js';
import { startQueueListener, drainAllInboundJobs } from './support/queue-worker.js';
import { schedule } from './lib/scheduler.js';
import { BUSINESS_TIMEZONE } from './analyst/constants.js';

const app = new Hono();
const PORT = Number(process.env.PORT) || 8080;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim());

app.use(
  '*',
  cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ['POST', 'GET', 'OPTIONS'],
    allowHeaders: ['content-type', 'x-service-token'],
    exposeHeaders: ['x-vercel-ai-ui-message-stream', 'x-message-id'],
    maxAge: 86400,
  }),
);

app.get('/health', (c) => c.json({ ok: true }));

app.post('/chat', async (c) => {
  const token = c.req.header('x-service-token');
  const auth = token ? verifyServiceToken(token) : null;
  if (!auth || auth.purpose !== 'chat' || !auth.conversationId) {
    return c.text('Unauthorized', 401);
  }
  const conversationId = auth.conversationId;

  const { messages } = (await c.req.json()) as { messages: UIMessage[] };
  if (!Array.isArray(messages) || messages.length === 0) {
    return c.text('Bad request: messages required', 400);
  }

  // Defense-in-depth: independently enforce per-user and per-org caps before
  // we burn any model tokens. Atomic + row-locked inside checkAndConsumeMessage
  // so concurrent submissions cannot race past the cap.
  let rate;
  try {
    rate = await checkAndConsumeMessage(auth.userId, auth.orgId);
  } catch (err) {
    console.error('[chat] rate-limit check failed', err);
    return c.json({ error: 'rate_limit_check_failed' }, 500);
  }
  if (!rate.ok) {
    return c.json(
      {
        error: 'rate_limit',
        scope: rate.scope,
        reason: rate.reason,
        resetAt: rate.resetAt,
        tokensUsed: rate.tokensUsed,
        tokenLimit: rate.tokenLimit,
        messagesUsed: rate.messagesUsed,
        messageLimit: rate.messageLimit,
      },
      429,
    );
  }

  // Persona is read from the verified token claim, never from the request body.
  const persona = resolvePersona(auth.model);
  const startedAt = new Date();
  const messageId = randomUUID();
  const requestSignal = c.req.raw.signal;

  const { stream, finishPromise } = runOrchestrator(
    messages,
    auth.userId,
    conversationId,
    auth.orgId,
    persona,
    requestSignal,
    messageId,
  );

  // finishPromise always resolves (success or partial-on-error) so this
  // webhook fires on every completed stream. That's the fix for the
  // "usage not updating" bug — error paths used to reject and skip the POST.
  finishPromise
    .then((result) =>
      postChatFinish({
        userId: auth.userId,
        orgId: auth.orgId,
        conversationId,
        text: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        finishReason: result.finishReason,
        messageId: result.messageId || messageId,
        resourcesUsed: result.resourcesUsed,
      }),
    )
    .catch((err) => {
      console.error('[chat] post-finish webhook failed', err);
    });

  // Cost analytics — failure must not affect the chat response.
  finishPromise
    .then((result) =>
      recordChatAgentRun({
        userId: auth.userId,
        orgId: auth.orgId,
        conversationId,
        persona: result.persona,
        providerModelId: result.providerModelId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        text: result.text,
        finishReason: result.finishReason,
        startedAt,
        tokenBreakdown: result.tokenBreakdown,
        agentCount: result.agentCount,
      }),
    )
    .catch((err) => {
      console.error('[chat] AgentRun logging failed', err);
    })
    .finally(async () => {
      // Flush Langfuse traces after request completes
      try {
        await flushLangfuse();
      } catch (err) {
        console.error('[chat] Langfuse flush failed', err);
      }
    });

  const sseStream = stream.pipeThrough(new JsonToSseTransformStream()).pipeThrough(
    new TextEncoderStream(),
  );

  return new Response(sseStream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-vercel-ai-ui-message-stream': 'v1',
      'x-accel-buffering': 'no',
      'x-message-id': messageId,
    },
  });
});


app.route('/analyst', analyst);
app.route('/market-intelligence', marketIntelligence);
app.route('/gmail', gmail);
app.route('/whatsapp', whatsapp);
app.route('/support', support);
app.route('/content', content);
app.route('/revenue-loss', revenueLoss);
app.route('/shopify-data', shopifyData);

// Register channel adapters (outbound) and inbound sources before any route or
// worker that might dispatch through them (the gmail push webhook, the support
// agent, the sender worker, the inbound queue sweep). A new channel registers
// both an adapter and (if it polls a job table) an inbound source here.
registerChannelAdapter(gmailAdapter);
registerInboundSource(gmailInboundSource);
// WhatsApp's webhook carries the full message payload, so it calls
// processInboundMessages() directly and has no InboundSource to register.
registerChannelAdapter(whatsappAdapter);

serve({ fetch: app.fetch, port: PORT });
console.log(`llm-proxy listening on :${PORT}`);

// Start analyst worker and register per-module cron sweeps.
// Wrapped in a void async block so startup errors are logged without
// crashing the HTTP server — analyst jobs are non-critical background work.
//
// Reaping orphan jobs on startup is critical: without it, any AnalystJob
// left at RUNNING by a crashed/redeployed worker permanently occupies the
// partial unique index on (orgId, insightType), silently blocking every
// future sweep for that pair.
reapStaleAnalystJobs().catch((err) =>
  console.error('[analyst] reap startup failed:', err),
);
startAnalystRunner();
startAnalystScheduler();
startMarketIntelligenceWorker();
startContentWorker();

// Renew Gmail push watches daily at 03:00 (business tz). Gmail watches expire
// after 7 days; the renewal sweep re-watches any mailbox expiring within 48h,
// so a single missed run never drops a watch. Also runs once on startup to pick
// up newly-connected mailboxes that have no watch yet.
schedule('0 3 * * *', BUSINESS_TIMEZONE, 'gmail-watch-renew', async () => {
  await renewGmailWatches();
});
renewGmailWatches().catch((err) =>
  console.error('[gmail] startup watch renewal failed:', err),
);

// Channel-agnostic support agent. Reap orphaned jobs on startup (same
// rationale as the analyst: a stale RUNNING/QUEUED row wedges the
// per-conversation active-job unique index), then start the poll-and-dispatch
// worker that drafts replies for enqueued SupportAgentJob rows, plus the
// outbox sender that delivers approved replies via each channel's adapter.
reapStaleSupportAgentJobs().catch((err) =>
  console.error('[support-agent] reap startup failed:', err),
);
startSupportAgentWorker();
startSupportSenderWorker();

// Drain any inbound jobs left PENDING from a crash/restart before the first
// 5-minute sweep tick fires. Without this, messages that arrived while the
// server was down would sit unprocessed for up to 5 minutes.
(async () => {
  try {
    const drained = await drainAllInboundJobs();
    if (drained > 0) console.log(`[support] startup drain: processed ${drained} pending inbound job(s)`);
  } catch (err) {
    console.error('[support] startup drain failed:', err);
  }
})();

const stopQueueListener = startQueueListener(300000);
console.log('⚡ Event-Driven Support processing ready. 5-Minute Queue Sweep Listener online.');

// Graceful shutdown: drain in-flight jobs so a redeploy doesn't leave
// orphan RUNNING rows that wedge the analyst.
const handleShutdownSignal = (signal: string) => {
  console.log(`[shutdown] received ${signal}, draining workers...`);
  stopQueueListener();
  Promise.all([
    shutdownAnalyst(),
    shutdownMarketIntelligenceWorker(),
    shutdownContentWorker(),
    shutdownSupportAgentWorker(),
    shutdownSupportSenderWorker(),
    flushLangfuse(),
  ])
    .catch((err) => console.error('[shutdown] error:', err))
    .finally(() => process.exit(0));
};
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

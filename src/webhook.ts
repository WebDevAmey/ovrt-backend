import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { signServiceToken } from './service-token.js';
import type { Persona } from './personas.js';
import type { TokenBreakdownEntry } from './agents/types.js';
import type { ResourceUsed } from './orchestrator/types.js';

const NEXT_JS_URL = process.env.NEXT_JS_URL!;

// One Job + one AgentRun per /chat invocation. agentName carries the persona
// (greenet|idol-3|desert-blue) so cost analytics can group on it; modelName is
// the resolved provider model id (e.g. gpt-5). No retries — analytics row
// failing must never break the user-visible chat response.
export async function recordChatAgentRun(args: {
  userId: string;
  orgId: string;
  conversationId: string;
  persona: Persona;
  providerModelId: string;
  inputTokens: number;
  outputTokens: number;
  text: string;
  finishReason: string;
  startedAt: Date;
  tokenBreakdown?: TokenBreakdownEntry[];
  agentCount?: number;
}): Promise<void> {
  const now = new Date();
  const latencyMs = now.getTime() - args.startedAt.getTime();
  const isAbortOrError = args.finishReason === 'error' || args.finishReason === 'abort';
  const jobStatus = isAbortOrError ? 'FAILED' : 'SUCCEEDED';
  const runStatus = isAbortOrError ? 'FAILED' : 'SUCCEEDED';

  const job = await prisma.job.create({
    data: {
      conversationId: args.conversationId,
      userId: args.userId,
      threadId: randomUUID(),
      status: jobStatus,
      startedAt: args.startedAt,
      finishedAt: now,
    },
  });

  await prisma.agentRun.create({
    data: {
      jobId: job.id,
      agentName: args.persona,
      status: runStatus,
      modelProvider: 'openai',
      modelName: args.providerModelId,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costMicros: 0,
      latencyMs,
      input: { persona: args.persona },
      output: {
        text: args.text,
        finishReason: args.finishReason,
        agentCount: args.agentCount ?? 0,
        tokenBreakdown: args.tokenBreakdown ?? [],
      },
      startedAt: args.startedAt,
      finishedAt: now,
    },
  });
}

export async function postChatFinish(args: {
  userId: string;
  orgId: string;
  conversationId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  messageId: string;
  resourcesUsed?: ResourceUsed[];
}): Promise<void> {
  const token = signServiceToken(
    {
      userId: args.userId,
      orgId: args.orgId,
      purpose: 'chat',
      conversationId: args.conversationId,
    },
    300,
  );

  const res = await fetch(`${NEXT_JS_URL}/api/chat/finish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-service-token': token },
    body: JSON.stringify({
      text: args.text,
      finishReason: args.finishReason,
      messageId: args.messageId,
      usage: {
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
      },
      resourcesUsed: args.resourcesUsed ?? [],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`webhook failed: ${res.status} ${body}`);
  }

  // /api/chat/finish is the row that creates the Message record. Only after
  // it returns ok can we be sure the row exists — racing the update before
  // this point produced P2025 "no record found" errors. We still write it
  // ourselves because the frontend endpoint does not persist resourcesUsed.
  if (args.messageId && args.resourcesUsed && args.resourcesUsed.length > 0) {
    prisma.message
      .update({
        where: { id: args.messageId },
        data: { resourcesUsed: args.resourcesUsed },
      })
      .catch((err) => console.error('[webhook] failed to persist resourcesUsed', err));
  }
}

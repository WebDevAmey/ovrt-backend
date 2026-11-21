/**
 * Support routes
 * ===============
 * Mounted at /support in src/index.ts.
 *
 *   POST /support/conversations/:conversationId/approve   approve a DRAFT reply.
 *
 * Channel-specific routes (Gmail push/watch/renew, future WhatsApp/IG webhooks)
 * stay under their own channel's mount point (e.g. /gmail) — this file is for
 * the channel-agnostic conversation lifecycle only.
 */

import { Hono } from 'hono';
import { prisma } from '../prisma.js';
import { verifyServiceToken } from '../service-token.js';
import { parseActionPolicy } from './actions/permissions.js';

const support = new Hono();

/**
 * POST /support/conversations/:conversationId/approve
 *
 * Approves the pending DRAFT reply on a conversation so the sender worker will
 * pick it up and deliver it. The frontend calls this when a human reviews and
 * accepts the agent-drafted reply.
 *
 * Auth: service token with purpose 'gmail' or 'support'. The orgId in the
 * token is checked against the conversation's organisationId so one org can
 * never approve another's conversations.
 *
 * Body: optional { messageId } — if provided, approves that specific OUTBOUND
 * message. If omitted, approves the latest DRAFT message on the conversation.
 *
 * Response:
 *   200 { ok: true, messageId, conversationId }
 *   400 if no DRAFT message exists on the conversation
 *   403 if the conversation belongs to a different org
 *   404 if the conversation is not found
 */
support.post('/conversations/:conversationId/approve', async (c) => {
  const token = c.req.header('x-service-token');
  const auth = token ? verifyServiceToken(token) : null;
  if (!auth || (auth.purpose !== 'gmail' && auth.purpose !== 'support')) return c.text('Unauthorized', 401);

  const conversationId = c.req.param('conversationId');
  const body = (await c.req.json().catch(() => ({}))) as { messageId?: string };

  const conversation = await prisma.supportConversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        where: { direction: 'OUTBOUND', status: 'DRAFT' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!conversation) return c.json({ error: 'conversation not found' }, 404);
  if (conversation.organisationId !== auth.orgId) return c.json({ error: 'forbidden' }, 403);

  // Pick the specific message if requested, otherwise the latest DRAFT.
  const msg = body.messageId
    ? conversation.messages.find((m) => m.id === body.messageId)
    : conversation.messages[0];

  if (!msg) return c.json({ error: 'no pending draft on this conversation' }, 400);

  await prisma.$transaction([
    prisma.supportMessage.update({
      where: { id: msg.id },
      data: { status: 'APPROVED' },
    }),
    prisma.supportConversation.update({
      where: { id: conversation.id },
      data: { status: 'READY_TO_SEND' },
    }),
  ]);

  console.log(`[support] conversation ${conversation.id}: draft approved by user ${auth.userId}`);
  return c.json({ ok: true, messageId: msg.id, conversationId: conversation.id });
});

/**
 * GET /support/config/action-permissions
 *
 * Returns the org's normalised write-action policy (per-action toggles +
 * guardrails) and return window. Always returns a fully-populated policy with
 * safe defaults even if the org has never configured one.
 *
 * Auth: service token with purpose 'gmail' or 'support'.
 */
support.get('/config/action-permissions', async (c) => {
  const token = c.req.header('x-service-token');
  const auth = token ? verifyServiceToken(token) : null;
  if (!auth || (auth.purpose !== 'gmail' && auth.purpose !== 'support')) return c.text('Unauthorized', 401);

  const config = await prisma.supportAgentConfig.findUnique({
    where: { organisationId: auth.orgId },
    select: { actionPermissions: true, returnWindowDays: true },
  });

  return c.json({
    actionPermissions: parseActionPolicy(config?.actionPermissions),
    returnWindowDays: config?.returnWindowDays ?? null,
  });
});

/**
 * PUT /support/config/action-permissions
 *
 * Sets the org's write-action policy. The incoming body is normalised through
 * parseActionPolicy (deny-by-default) before storage, so a partial or malformed
 * payload can never widen permissions or break the stored shape.
 *
 * Body: { actionPermissions?: <partial policy>, returnWindowDays?: number | null }
 *
 * Auth: service token with purpose 'gmail' or 'support'.
 */
support.put('/config/action-permissions', async (c) => {
  const token = c.req.header('x-service-token');
  const auth = token ? verifyServiceToken(token) : null;
  if (!auth || (auth.purpose !== 'gmail' && auth.purpose !== 'support')) return c.text('Unauthorized', 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    actionPermissions?: unknown;
    returnWindowDays?: number | null;
  };

  // Normalise to the safe, fully-populated policy before persisting.
  const policy = parseActionPolicy(body.actionPermissions);
  const returnWindowDays =
    typeof body.returnWindowDays === 'number' && Number.isFinite(body.returnWindowDays) && body.returnWindowDays >= 0
      ? Math.floor(body.returnWindowDays)
      : null;

  const saved = await prisma.supportAgentConfig.upsert({
    where: { organisationId: auth.orgId },
    update: { actionPermissions: policy as object, returnWindowDays },
    create: { organisationId: auth.orgId, actionPermissions: policy as object, returnWindowDays },
    select: { actionPermissions: true, returnWindowDays: true },
  });

  console.log(`[support] org ${auth.orgId}: action permissions updated by user ${auth.userId}`);
  return c.json({
    ok: true,
    actionPermissions: parseActionPolicy(saved.actionPermissions),
    returnWindowDays: saved.returnWindowDays ?? null,
  });
});

export { support };

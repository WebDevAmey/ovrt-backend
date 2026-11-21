import type { Context } from 'hono';
import { prisma } from '../prisma.js';
import { getAnalystTaskRunner } from './runner-instance.js';
import { runOpportunityCurationSweep } from './opportunity/index.js';

/**
 * GET /analyst/opportunities
 * Returns OPEN/VIEWED/EXPLORING opportunities for the org, highest priority first.
 */
export async function handleGetOpportunities(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;

  const opportunities = await prisma.opportunity.findMany({
    where: { organisationId: orgId, status: { in: ['OPEN', 'VIEWED', 'EXPLORING'] } },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      priority: true,
      status: true,
      source: true,
      evidence: true,
      sourceAnomalyId: true,
      createdAt: true,
    },
  });

  return c.json({ opportunities });
}

/**
 * POST /analyst/opportunities/:id/view
 * Marks an opportunity VIEWED. No-op (still 200) if already past OPEN.
 */
export async function handleViewOpportunity(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;
  const id = c.req.param('id');

  const existing = await prisma.opportunity.findFirst({
    where: { id, organisationId: orgId },
    select: { id: true, status: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);

  if (existing.status !== 'OPEN') {
    const opportunity = await prisma.opportunity.findUnique({ where: { id } });
    return c.json({ opportunity });
  }

  const opportunity = await prisma.opportunity.update({
    where: { id },
    data: { status: 'VIEWED', viewedAt: new Date() },
  });

  return c.json({ opportunity });
}

/**
 * POST /analyst/opportunities/:id/explore
 * Body: { conversationId: string }
 * Marks the opportunity EXPLORING, links the conversation, and — when
 * anomaly-backed — returns the source anomaly's factData/job context so the
 * frontend can attach it to the conversation for chat injection (mirrors the
 * old hook-engage flow).
 */
export async function handleExploreOpportunity(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;
  const id = c.req.param('id');

  const existing = await prisma.opportunity.findFirst({
    where: { id, organisationId: orgId },
    select: { id: true, status: true, sourceAnomalyId: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);

  let conversationId: string | undefined;
  try {
    const body = await c.req.json();
    if (typeof body?.conversationId === 'string' && body.conversationId.length > 0) {
      conversationId = body.conversationId;
    }
  } catch {
    // Body is optional — ignore parse errors
  }

  const opportunity = await prisma.opportunity.update({
    where: { id },
    data: {
      status: 'EXPLORING',
      ...(conversationId ? { conversationId } : {}),
    },
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      priority: true,
      status: true,
      source: true,
      evidence: true,
      sourceAnomalyId: true,
      conversationId: true,
    },
  });

  let anomaly: unknown = null;
  if (existing.sourceAnomalyId) {
    anomaly = await prisma.insightAnomaly.findUnique({
      where: { id: existing.sourceAnomalyId },
      select: {
        id: true,
        anomalyDetails: true,
        detectedAt: true,
        job: {
          select: {
            insightType: true,
            sourceId: true,
            sourceType: true,
            factData: true,
          },
        },
      },
    });
  }

  return c.json({ opportunity, anomaly });
}

/**
 * POST /analyst/opportunities/:id/dismiss
 */
export async function handleDismissOpportunity(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;
  const id = c.req.param('id');

  const existing = await prisma.opportunity.findFirst({
    where: { id, organisationId: orgId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const opportunity = await prisma.opportunity.update({
    where: { id },
    data: { status: 'DISMISSED', dismissedAt: new Date() },
  });

  return c.json({ opportunity });
}

/**
 * POST /analyst/opportunities/:id/done
 */
export async function handleCompleteOpportunity(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;
  const id = c.req.param('id');

  const existing = await prisma.opportunity.findFirst({
    where: { id, organisationId: orgId },
    select: { id: true },
  });
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const opportunity = await prisma.opportunity.update({
    where: { id },
    data: { status: 'DONE', doneAt: new Date() },
  });

  return c.json({ opportunity });
}

/**
 * POST /analyst/opportunities/curate
 * Manual trigger for the anomaly curation engine, bypassing the 4-day rate
 * gate (mirrors handleTrigger's manual-bypass behaviour for sweeps).
 */
export async function handleTriggerCuration(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;

  getAnalystTaskRunner().run(`curation-trigger:${orgId}`, () =>
    runOpportunityCurationSweep(orgId, true),
  );

  return c.json({ triggered: true, orgId });
}

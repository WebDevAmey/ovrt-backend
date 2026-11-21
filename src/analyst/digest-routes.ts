import type { Context } from 'hono';
import { prisma } from '../prisma.js';
import { getAnalystTaskRunner } from './runner-instance.js';
import { runWeeklyDigest } from './weekly-digest/index.js';
import { resolveShopifySource, getShopifyConn } from './modules/shopify-shared.js';
import { computeDigestWindow } from './weekly-digest/index.js';
import { BUSINESS_TIMEZONE } from './constants.js';

/**
 * POST /analyst/digest/trigger
 *
 * Enqueues a digest generation job for the calling org's most recently
 * completed ISO week. Returns immediately; the digest is generated async.
 * If a non-failed digest already exists for the week, returns 409.
 */
export async function handleTriggerDigest(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;

  const sourceId = await resolveShopifySource(orgId);
  if (!sourceId) {
    return c.json({ error: 'No active Shopify integration found' }, 400);
  }

  const conn = await getShopifyConn(sourceId);
  const window = computeDigestWindow(new Date(), conn.timezone ?? BUSINESS_TIMEZONE);
  const weekStartDt = new Date(`${window.weekStart}T00:00:00Z`);

  const existing = await prisma.weeklyDigest.findFirst({
    where: {
      organisationId: orgId,
      weekStart: weekStartDt,
      status: { in: ['QUEUED', 'RUNNING', 'SUCCEEDED'] },
    },
    select: { id: true, status: true },
  });

  if (existing) {
    return c.json(
      { error: 'Digest already exists for this week', digestId: existing.id, status: existing.status },
      409,
    );
  }

  const ws = window.weekStart;
  const we = window.weekEnd;
  const sourceId_ = sourceId;
  const orgId_ = orgId;

  getAnalystTaskRunner().run(`digest-trigger:${orgId_}:${ws}`, async () => {
    // Reset a FAILED row if present (HTTP retrigger), otherwise create fresh.
    const failedRow = await prisma.weeklyDigest.findFirst({
      where: { organisationId: orgId_, weekStart: weekStartDt, status: 'FAILED' },
      select: { id: true },
    });

    let digest: { id: string };
    if (failedRow) {
      digest = await prisma.weeklyDigest.update({
        where: { id: failedRow.id },
        data: { status: 'QUEUED', error: null, completedAt: null, startedAt: null },
        select: { id: true },
      });
    } else {
      try {
        digest = await prisma.weeklyDigest.create({
          data: {
            organisationId: orgId_,
            weekStart: weekStartDt,
            weekEnd: new Date(`${we}T23:59:59Z`),
            status: 'QUEUED',
          },
          select: { id: true },
        });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code === 'P2002') {
          console.log(`[digest] trigger: race-lost for org=${orgId_}, weekStart=${ws}`);
          return;
        }
        throw err;
      }
    }
    await runWeeklyDigest(digest.id, sourceId_, orgId_, ws, we);
  });

  return c.json({
    queued: true,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    orgId,
  });
}

/**
 * GET /analyst/digest
 *
 * Returns the most recent weekly digests for the calling org.
 * Pagination via cursor (digest id) + limit (max 50, default 10).
 * Summary JSON is omitted from list responses to keep payloads small;
 * fetch GET /analyst/digest/:id for the full content.
 */
export async function handleGetDigests(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;

  const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10), 50);
  const cursor = c.req.query('cursor');

  const digests = await prisma.weeklyDigest.findMany({
    where: { organisationId: orgId },
    orderBy: { weekStart: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      weekStart: true,
      weekEnd: true,
      status: true,
      generatedByModel: true,
      completedAt: true,
      createdAt: true,
      error: true,
    },
  });

  const hasMore = digests.length > limit;
  const items = hasMore ? digests.slice(0, limit) : digests;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return c.json({ items, nextCursor });
}

/**
 * GET /analyst/digest/:id
 *
 * Returns a single digest with its full summary JSON and all linked
 * Opportunity rows (source=WEEKLY_DIGEST, ordered by priority descending).
 */
export async function handleGetDigest(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;
  const id = c.req.param('id');

  const digest = await prisma.weeklyDigest.findFirst({
    where: { id, organisationId: orgId },
  });

  if (!digest) {
    return c.json({ error: 'Not found' }, 404);
  }

  const opportunities = await prisma.opportunity.findMany({
    where: { organisationId: orgId, source: 'WEEKLY_DIGEST', sourceRef: id },
    orderBy: { priority: 'desc' },
    select: {
      id: true,
      title: true,
      description: true,
      category: true,
      priority: true,
      status: true,
      evidence: true,
      generatedByModel: true,
      createdAt: true,
    },
  });

  return c.json({ digest, opportunities });
}

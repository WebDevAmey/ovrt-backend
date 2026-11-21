import { Hono } from 'hono';
import { prisma } from '../prisma.js';
import { verifyServiceToken } from '../service-token.js';
import { getMiTaskRunner } from './runner-instance.js';
import { runMarketAnalysis } from './runner.js';

type MIEnv = {
  Variables: {
    miAuth: { userId: string; orgId: string };
  };
};

const marketIntelligence = new Hono<MIEnv>();

// Auth middleware — reuse the 'analyst' purpose token (same frontend token flow)
marketIntelligence.use('*', async (c, next) => {
  const token = c.req.header('x-service-token');
  const payload = token ? verifyServiceToken(token) : null;
  if (!payload || payload.purpose !== 'analyst') {
    return c.text('Unauthorized', 401);
  }
  c.set('miAuth', { userId: payload.userId, orgId: payload.orgId });
  await next();
});

/**
 * POST /market-intelligence/analyze
 *
 * Triggers a market + competitor analysis for the authenticated org.
 * Fire-and-forget: creates a DB record, enqueues a background job, returns immediately.
 *
 * If an analysis is already QUEUED or RUNNING for this org, returns the
 * existing record (409) so the frontend can show progress rather than
 * queuing duplicate work.
 *
 * Response 200: { analysisId, status: 'queued' }
 * Response 409: { analysisId, status: 'queued'|'running', message }
 */
marketIntelligence.post('/analyze', async (c) => {
  const { orgId } = c.get('miAuth');

  // Guard: one active job per org
  const existing = await prisma.marketAnalysis.findFirst({
    where: { organisationId: orgId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true, status: true },
  });

  if (existing) {
    return c.json(
      {
        analysisId: existing.id,
        status: existing.status.toLowerCase(),
        message: 'An analysis is already in progress for this organisation.',
      },
      409,
    );
  }

  // Create DB record
  const analysis = await prisma.marketAnalysis.create({
    data: { organisationId: orgId, status: 'QUEUED' },
    select: { id: true },
  });

  getMiTaskRunner().run(`mi-run:${analysis.id}`, () =>
    runMarketAnalysis(analysis.id, orgId),
  );

  return c.json({ analysisId: analysis.id, status: 'queued' }, 200);
});

/**
 * GET /market-intelligence/latest
 *
 * Returns the most recent MarketAnalysis record for the org (any status).
 * The frontend should poll this until status === 'succeeded' or 'failed'.
 *
 * Response 200: { analysis: MarketAnalysis | null }
 *
 * See types.ts for the shape of each JSON column:
 *   queryContext  → QueryContext
 *   marketOverview → MarketOverview
 *   competitors   → CompetitorProfile[]
 *   marketTrends  → MarketTrends
 *   targetAudience → TargetAudience
 *   sources       → Source[]
 */
marketIntelligence.get('/latest', async (c) => {
  const { orgId } = c.get('miAuth');

  const analysis = await prisma.marketAnalysis.findFirst({
    where: { organisationId: orgId },
    orderBy: { createdAt: 'desc' },
  });

  return c.json({ analysis });
});

/**
 * GET /market-intelligence/list
 *
 * Returns up to 10 recent analyses for the org (for history view).
 * Response 200: { analyses: MarketAnalysis[] }
 */
marketIntelligence.get('/list', async (c) => {
  const { orgId } = c.get('miAuth');

  const analyses = await prisma.marketAnalysis.findMany({
    where: { organisationId: orgId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      status: true,
      createdAt: true,
      completedAt: true,
      startedAt: true,
      error: true,
      queryContext: true,
      // Omit heavy JSON blobs from list view — load on demand via /latest or a future /get/:id
    },
  });

  return c.json({ analyses });
});

export { marketIntelligence };

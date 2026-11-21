import { Hono } from 'hono';
import { verifyServiceToken } from '../service-token.js';
import { getContentTaskRunner } from './runner-instance.js';
import { runContentGenerationJob, type BrandTokens } from './runner.js';
import { randomUUID } from 'node:crypto';

type ContentEnv = {
  Variables: {
    contentAuth: { userId: string; orgId: string };
  };
};

const content = new Hono<ContentEnv>();

content.use('*', async (c, next) => {
  const token = c.req.header('x-service-token');
  const payload = token ? verifyServiceToken(token) : null;
  if (!payload || payload.purpose !== 'content') {
    return c.text('Unauthorized', 401);
  }
  c.set('contentAuth', { userId: payload.userId, orgId: payload.orgId });
  await next();
});

/**
 * POST /content/generate
 *
 * Accepts a batch of nodeIds to generate HTML content for. Returns immediately
 * with a jobId; generation runs in the background and posts results back to the
 * frontend via /api/content/callback as each node finishes.
 *
 * Response 200: { ok: true, jobId: string }
 */
content.post('/generate', async (c) => {
  const { userId, orgId } = c.get('contentAuth');

  const body = (await c.req.json()) as {
    treeId?: unknown;
    nodeIds?: unknown;
    prompt?: unknown;
    ratio?: unknown;
    count?: unknown;
    platform?: unknown;
    extraInstructions?: unknown;
    brandTokens?: unknown;
    previousHtml?: unknown;
    productIds?: unknown;
    referenceImageUrls?: unknown;
  };

  const { treeId, nodeIds, prompt, ratio, count, platform, extraInstructions, brandTokens, previousHtml, productIds, referenceImageUrls } = body;

  if (typeof treeId !== 'string' || !treeId) return c.json({ error: 'treeId required' }, 400);
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) return c.json({ error: 'nodeIds required' }, 400);
  if (!nodeIds.every((id) => typeof id === 'string')) return c.json({ error: 'nodeIds must be strings' }, 400);
  if (typeof prompt !== 'string' || !prompt) return c.json({ error: 'prompt required' }, 400);

  const resolvedRatio = typeof ratio === 'string' ? ratio : '1:1';
  const resolvedCount = typeof count === 'number' ? count : nodeIds.length;
  const resolvedPlatform = typeof platform === 'string' ? platform : 'instagram';
  const resolvedExtra = typeof extraInstructions === 'string' ? extraInstructions : null;
  const resolvedTokens: BrandTokens | null =
    brandTokens && typeof brandTokens === 'object' && !Array.isArray(brandTokens)
      ? (brandTokens as BrandTokens)
      : null;
  const resolvedPreviousHtml = typeof previousHtml === 'string' && previousHtml.trim() ? previousHtml : null;
  const resolvedProductIds =
    Array.isArray(productIds) && productIds.every((id) => typeof id === 'string')
      ? (productIds as string[])
      : null;
  const resolvedReferenceImageUrls =
    Array.isArray(referenceImageUrls) && referenceImageUrls.every((u) => typeof u === 'string')
      ? (referenceImageUrls as string[])
      : null;

  const jobId = randomUUID();

  getContentTaskRunner().run(`content-gen:${jobId}`, () =>
    runContentGenerationJob({
      treeId,
      nodeIds: nodeIds as string[],
      prompt,
      ratio: resolvedRatio,
      count: resolvedCount,
      platform: resolvedPlatform,
      extraInstructions: resolvedExtra,
      brandTokens: resolvedTokens,
      orgId,
      userId,
      previousHtml: resolvedPreviousHtml,
      productIds: resolvedProductIds,
      referenceImageUrls: resolvedReferenceImageUrls,
    }),
  );

  return c.json({ ok: true, jobId });
});

export { content };

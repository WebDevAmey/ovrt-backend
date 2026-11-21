import { Hono } from 'hono';
import { verifyServiceToken, type ServicePayload } from '../service-token.js';
import { prisma } from '../prisma.js';
import { calculateCheckoutLoss } from './checkout.js';
import { calculateRefundRevenueLoss } from './refund.js';
import { loadRuleResolver } from './rules.js';
import { resolveShopifyConnection } from '../agents/shopify/credentials.js';

export const revenueLoss = new Hono<{
  Variables: {
    jwtPayload: ServicePayload;
  };
}>();

// Authentication Middleware
revenueLoss.use('*', async (c, next) => {
  const token = c.req.header('x-service-token');
  if (!token) {
    return c.json({ error: 'Missing service token' }, 401);
  }

  const payload = verifyServiceToken(token);
  if (!payload || payload.purpose !== 'revenue-loss') {
    return c.json({ error: 'Invalid or unauthorized service token' }, 401);
  }

  // Store payload in context for later use
  c.set('jwtPayload', payload);
  await next();
});

revenueLoss.post('/checkout', async (c) => {
  const payload = c.get('jwtPayload');
  const orgId = payload.orgId;

  try {
    const body = await c.req.json();
    const { startDate, endDate } = body;

    if (!startDate || !endDate) {
      return c.json({ error: 'startDate and endDate are required' }, 400);
    }

    // Validate dates: must be parseable ISO/date strings and startDate <= endDate.
    // Both are interpolated into the ShopifyQL query string, so reject anything
    // that isn't a real date before it produces an opaque Shopify API error.
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return c.json({ error: 'startDate and endDate must be valid date strings' }, 400);
    }
    if (start.getTime() > end.getTime()) {
      return c.json({ error: 'startDate must be on or before endDate' }, 400);
    }

    // Look up active shopifyIntegration for this organization
    const integration = await prisma.shopifyIntegration.findFirst({
      where: {
        organisationId: orgId,
        status: 'ACTIVE',
      },
    });

    if (!integration) {
      return c.json({ error: 'No active Shopify integration found for this organization' }, 404);
    }

    // Resolve connection (handles decryption and metadata)
    const conn = await resolveShopifyConnection(integration.id);

    const result = await calculateCheckoutLoss(conn, { startDate, endDate });

    return c.json(result);
  } catch (err) {
    console.error('[revenue-loss/checkout] calculation failed', err);
    
    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // Don't leak internal/Shopify error text (may include connection detail) to
    // the caller — it's already logged above. Surface a generic message only.
    return c.json({
      error: 'An internal error occurred while processing revenue loss analytics',
    }, 500);
  }
});

revenueLoss.post('/refund', async (c) => {
  const payload = c.get('jwtPayload');
  const orgId = payload.orgId;

  try {
    const body = await c.req.json();
    const { startDate, endDate } = body;

    if (!startDate || !endDate) {
      return c.json({ error: 'startDate and endDate are required' }, 400);
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return c.json({ error: 'startDate and endDate must be valid date strings' }, 400);
    }
    if (start.getTime() > end.getTime()) {
      return c.json({ error: 'startDate must be on or before endDate' }, 400);
    }

    const integration = await prisma.shopifyIntegration.findFirst({
      where: {
        organisationId: orgId,
        status: 'ACTIVE',
      },
    });

    if (!integration) {
      return c.json({ error: 'No active Shopify integration found for this organization' }, 404);
    }

    // Load the versioned cost rules for this integration. Unlike the old flow we
    // do NOT hard-fail when none are configured: measured values (real gateway
    // fees, outbound shipping) still produce a meaningful number. The result
    // flags `usingFallbackRules` so the caller can prompt the merchant to
    // configure estimates for the rest.
    const { resolve } = await loadRuleResolver(integration.id);

    const conn = await resolveShopifyConnection(integration.id);
    const result = await calculateRefundRevenueLoss(conn, resolve, { startDate, endDate });

    return c.json(result);
  } catch (err) {
    console.error('[revenue-loss/refund] calculation failed', err);

    if (err instanceof SyntaxError) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    return c.json({
      error: 'An internal error occurred while processing refund loss analytics',
    }, 500);
  }
});

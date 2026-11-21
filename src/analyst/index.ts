import { Hono } from 'hono';
import { verifyServiceToken } from '../service-token.js';
import { handleTrigger } from './trigger.js';
import {
  handleGetOpportunities,
  handleViewOpportunity,
  handleExploreOpportunity,
  handleDismissOpportunity,
  handleCompleteOpportunity,
  handleTriggerCuration,
} from './opportunities.js';
import { handleTriggerDigest, handleGetDigests, handleGetDigest } from './digest-routes.js';

type AnalystEnv = {
  Variables: {
    analystAuth: { userId: string; orgId: string };
  };
};

const analyst = new Hono<AnalystEnv>();

// Shared auth middleware for all analyst routes.
// Requires purpose: 'analyst'. No conversationId needed.
analyst.use('*', async (c, next) => {
  const token = c.req.header('x-service-token');
  const payload = token ? verifyServiceToken(token) : null;

  if (!payload || payload.purpose !== 'analyst') {
    return c.text('Unauthorized', 401);
  }

  // Stash verified auth on context for downstream handlers
  c.set('analystAuth', { userId: payload.userId, orgId: payload.orgId });
  await next();
});

// Routes
analyst.post('/trigger', handleTrigger);

// Opportunity routes
analyst.get('/opportunities', handleGetOpportunities);
analyst.post('/opportunities/curate', handleTriggerCuration);
analyst.post('/opportunities/:id/view', handleViewOpportunity);
analyst.post('/opportunities/:id/explore', handleExploreOpportunity);
analyst.post('/opportunities/:id/dismiss', handleDismissOpportunity);
analyst.post('/opportunities/:id/done', handleCompleteOpportunity);

// Weekly digest routes
analyst.post('/digest/trigger', handleTriggerDigest);
analyst.get('/digest', handleGetDigests);
analyst.get('/digest/:id', handleGetDigest);

export { analyst };

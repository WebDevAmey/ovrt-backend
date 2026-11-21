import { prisma } from '../prisma.js';
import type { WeeklyDigestContent } from '../analyst/weekly-digest/types.js';
import {
  assembleStoreIntelligence,
  EMPTY_STORE_INTELLIGENCE,
  CUSTOMER_INSIGHT_WINDOW_DAYS,
  MAX_HOOKS,
  type StoreIntelligence,
} from './store-brief.js';

export type { StoreIntelligence } from './store-brief.js';

/**
 * Store Intelligence layer — DB fetch
 * ===================================
 * Pulls the intelligence the analyst already persists and hands it to the pure
 * renderer in store-brief.ts. The goal: stop every chat turn from starting cold
 * — give the model the store's own baselines so it can judge whether a number
 * is good or bad, and let it proactively surface what's already flagged.
 *
 * Resilient by contract: any failure returns EMPTY rather than throwing, so a
 * store with no analyst data (or a transient DB error) degrades to today's
 * cold-start behaviour instead of breaking chat.
 */
export async function loadStoreIntelligence(orgId: string): Promise<StoreIntelligence> {
  try {
    const since = new Date(Date.now() - CUSTOMER_INSIGHT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [digest, opportunities, customerInsights] = await Promise.all([
      prisma.weeklyDigest.findFirst({
        where: { organisationId: orgId, status: 'SUCCEEDED' },
        orderBy: { weekStart: 'desc' },
        select: { summary: true },
      }),
      prisma.opportunity.findMany({
        where: { organisationId: orgId, status: { in: ['OPEN', 'VIEWED', 'EXPLORING'] } },
        orderBy: { priority: 'desc' },
        take: MAX_HOOKS,
        select: { title: true, description: true, category: true },
      }),
      prisma.customerInsight.findMany({
        where: {
          organisationId: orgId,
          status: { in: ['NEW', 'REVIEWED'] },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        // NOTE: `snippet` is attacker-controlled verbatim customer text and is
        // deliberately NOT selected. Only the analyst-generated `summary` is used.
        select: { type: true, sentiment: true, summary: true },
      }),
    ]);

    const digestContent = (digest?.summary ?? null) as unknown as WeeklyDigestContent | null;
    return assembleStoreIntelligence(digestContent, opportunities, customerInsights);
  } catch (err) {
    console.error('[orchestrator] loadStoreIntelligence failed — continuing without store brief', err);
    return EMPTY_STORE_INTELLIGENCE;
  }
}

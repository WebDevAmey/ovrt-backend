import { prisma } from '../../prisma.js';
import { resolveShopifySource } from '../modules/shopify-shared.js';
import { getAnalystTaskRunner } from '../runner-instance.js';
import { OPPORTUNITY_CURATION_INSIGHT_TYPE, OPPORTUNITY_CURATION_INTERVAL_MS } from '../constants.js';
import { curateOpportunities } from './curator.js';
import { writeOpportunities } from './writer.js';
import type { CurationAnomalyInput, CurationDigestSummary } from './types.js';
import type { WeeklyDigestContent } from '../weekly-digest/types.js';

/**
 * Runs one curation pass for a single org: gathers anomalies detected since
 * the last curation run plus the latest digest + store context, asks the
 * curator LLM for a small set of high-quality opportunities, and persists
 * them (deduped) via writeOpportunities.
 *
 * The 4-day cadence is enforced by the caller (runOpportunityCurationSweep)
 * via a marker AnalystJob row — this function always executes its pass when
 * invoked.
 */
async function runOpportunityCuration(orgId: string, sinceCutoff: Date): Promise<void> {
  const [dbAnomalies, latestDigestRow, org] = await Promise.all([
    prisma.insightAnomaly.findMany({
      where: { detectedAt: { gte: sinceCutoff }, job: { organisationId: orgId } },
      include: { job: { select: { insightType: true } } },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    }),
    prisma.weeklyDigest.findFirst({
      where: { organisationId: orgId, status: 'SUCCEEDED' },
      orderBy: { weekStart: 'desc' },
      select: { summary: true },
    }),
    prisma.organisation.findUnique({
      where: { id: orgId },
      select: { businessContext: true, orgIdentity: true },
    }),
  ]);

  const anomalies: CurationAnomalyInput[] = dbAnomalies.map((a) => ({
    id: a.id,
    insightType: a.job.insightType,
    anomalyDetails: a.anomalyDetails as Record<string, unknown>,
    promptContext: a.promptContext,
    detectedAt: a.detectedAt.toISOString().slice(0, 10),
  }));

  const digestContent = (latestDigestRow?.summary ?? null) as unknown as WeeklyDigestContent | null;
  const latestDigest: CurationDigestSummary | null = digestContent
    ? {
        headline: digestContent.headline,
        narrative: digestContent.narrative,
        healthScore: digestContent.healthScore,
        topWins: digestContent.topWins,
        topConcerns: digestContent.topConcerns,
        weekStart: digestContent.weekStart,
        weekEnd: digestContent.weekEnd,
      }
    : null;

  if (anomalies.length === 0 && !latestDigest) {
    console.log(`[opportunity] curation skipped: org=${orgId}, no anomalies or digest to ground on`);
    return;
  }

  const existing = await prisma.opportunity.findMany({
    where: { organisationId: orgId, status: { in: ['OPEN', 'VIEWED', 'EXPLORING'] } },
    select: { dedupeKey: true },
  });
  const existingDedupeKeys = existing.map((e) => e.dedupeKey).filter((k): k is string => Boolean(k));

  const drafts = await curateOpportunities({
    organisationId: orgId,
    anomalies,
    latestDigest,
    businessContext: org?.businessContext,
    orgIdentity: org?.orgIdentity,
    existingDedupeKeys,
  });

  const createdCount = await writeOpportunities(orgId, drafts, 'gpt-4o');
  console.log(
    `[opportunity] curation complete: org=${orgId}, anomaliesConsidered=${anomalies.length}, drafted=${drafts.length}, created=${createdCount}`,
  );
}

/**
 * Per-org sweep mirroring src/analyst/sweep.ts: resolves the Shopify source,
 * gates on a 4-day cadence (tracked via a marker AnalystJob with
 * insightType=OPPORTUNITY_CURATION so the existing active-job uniqueness
 * constraint and stale-job reaper apply for free), and enqueues the curation
 * pass on the shared analyst task runner.
 */
export async function runOpportunityCurationSweep(orgId?: string, bypassRateLimit = false): Promise<void> {
  const orgs = orgId
    ? await prisma.organisation.findMany({ where: { id: orgId }, select: { id: true } })
    : await prisma.organisation.findMany({ select: { id: true } });

  let submitted = 0;

  for (const org of orgs) {
    try {
      const sourceId = await resolveShopifySource(org.id);
      if (!sourceId) continue;

      const activeJob = await prisma.analystJob.findFirst({
        where: {
          organisationId: org.id,
          insightType: OPPORTUNITY_CURATION_INSIGHT_TYPE,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (activeJob) continue;

      const lastRun = await prisma.analystJob.findFirst({
        where: {
          organisationId: org.id,
          insightType: OPPORTUNITY_CURATION_INSIGHT_TYPE,
          status: { in: ['SUCCEEDED', 'FAILED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      if (!bypassRateLimit && lastRun) {
        const elapsed = Date.now() - lastRun.createdAt.getTime();
        if (elapsed < OPPORTUNITY_CURATION_INTERVAL_MS) continue;
      }

      // Anomalies are gathered back to the last successful run, or 4 days
      // back if this org has never run curation before.
      const sinceCutoff = lastRun?.createdAt ?? new Date(Date.now() - OPPORTUNITY_CURATION_INTERVAL_MS);

      const orgId_ = org.id;
      const sourceId_ = sourceId;
      getAnalystTaskRunner().run(`opportunity-curation:${orgId_}`, async () => {
        let markerJob: { id: string };
        try {
          markerJob = await prisma.analystJob.create({
            data: {
              organisationId: orgId_,
              insightType: OPPORTUNITY_CURATION_INSIGHT_TYPE,
              sourceType: 'shopify',
              sourceId: sourceId_,
              status: 'QUEUED',
            },
            select: { id: true },
          });
        } catch (err: unknown) {
          if ((err as { code?: string })?.code === 'P2002') {
            console.log(`[opportunity] curation skipped: active marker job exists org=${orgId_}`);
            return;
          }
          throw err;
        }

        try {
          await prisma.analystJob.update({
            where: { id: markerJob.id },
            data: { status: 'RUNNING', startedAt: new Date() },
          });
          await runOpportunityCuration(orgId_, sinceCutoff);
          await prisma.analystJob.update({
            where: { id: markerJob.id },
            data: { status: 'SUCCEEDED', completedAt: new Date() },
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error(`[opportunity] curation failed: org=${orgId_}`, err);
          await prisma.analystJob
            .update({
              where: { id: markerJob.id },
              data: { status: 'FAILED', completedAt: new Date(), error: errorMsg.slice(0, 500) },
            })
            .catch((e: unknown) => console.error('[opportunity] failed to mark marker job FAILED:', e));
        }
      });
      submitted++;
    } catch (err) {
      console.error(`[opportunity] sweep error: org=${org.id}`, err);
    }
  }

  console.log(
    `[opportunity] curation sweep complete: submitted=${submitted}/${orgs.length}${orgId ? `, scope=org:${orgId}` : ''}`,
  );
}

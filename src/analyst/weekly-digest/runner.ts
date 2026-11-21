import { prisma } from '../../prisma.js';
import { fetchDigestData, computeDigestWindow } from './fetcher.js';
import { generateDigest } from './generator.js';
import { computeHealthScore } from './health.js';
import { sendWeeklyDigestEmail } from '../../email/weekly-digest.js';
import { pctChange } from './utils.js';
import { ANALYST_ZSCORE_THRESHOLD } from '../constants.js';
import type { DigestAnomalySummary, DigestWeekOverWeek, WeeklyDigestContent } from './types.js';
import type { OpportunityDraft } from '../opportunity/types.js';

/**
 * Maps a z-score to a severity band derived from the module's detection
 * threshold, so presentation stays consistent with what actually trips an
 * anomaly. Anything at/above 2× the threshold is "high", at/above 1.25× is
 * "medium", and the rest (already past the detection floor) is "low".
 */
function severityForZScore(absZ: number): DigestAnomalySummary['severity'] {
  if (absZ >= ANALYST_ZSCORE_THRESHOLD * 2) return 'high';
  if (absZ >= ANALYST_ZSCORE_THRESHOLD * 1.25) return 'medium';
  return 'low';
}

/**
 * Builds a human summary line for an anomaly, falling back to a number pulled
 * from anomalyDetails when promptContext is missing or too terse, so the digest
 * never degrades to a bare insightType with no signal.
 */
function anomalySummaryLine(
  promptContext: string | null | undefined,
  insightType: string,
  details: Record<string, unknown>,
): string {
  const fromContext = promptContext?.split('\n').find((l) => l.trim().length > 10);
  if (fromContext) return fromContext.trim();

  const actual = typeof details.actualValue === 'number' ? details.actualValue : undefined;
  const mean = typeof details.mean === 'number' ? details.mean : undefined;
  const direction = typeof details.direction === 'string' ? details.direction : 'anomaly';
  if (actual !== undefined && mean !== undefined) {
    return `${insightType}: ${direction} — observed ${actual} vs. baseline ${mean}`;
  }
  if (actual !== undefined) {
    return `${insightType}: ${direction} — observed ${actual}`;
  }
  return insightType;
}

/**
 * Full pipeline for one weekly digest run.
 *
 *  1. Mark digest RUNNING
 *  2. Fetch Shopify metrics for the covered week + prior week
 *  3. Load anomalies detected this week from InsightAnomaly
 *  4. Call LLM to generate summary + recommendations
 *  5. Persist WeeklyDigest.summary + Recommendation rows atomically
 *  6. Mark SUCCEEDED
 *  7. Email all org users
 *
 * On any error the digest is marked FAILED and the exception is rethrown
 * so the task runner's retry loop can attempt recovery.
 */
export async function runWeeklyDigest(
  digestId: string,
  integrationId: string,
  orgId: string,
  weekStart: string, // YYYY-MM-DD
  weekEnd: string,   // YYYY-MM-DD
): Promise<void> {
  try {
    await prisma.weeklyDigest.update({
      where: { id: digestId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    // Use computeDigestWindow to derive all four date bounds consistently,
    // avoiding the manual arithmetic that diverges if the function is updated.
    const digestWindow = computeDigestWindow(new Date(`${weekStart}T00:00:00Z`));
    const window = {
      weekStart,
      weekEnd,
      priorWeekStart: digestWindow.priorWeekStart,
      priorWeekEnd: digestWindow.priorWeekEnd,
    };

    // Fetch store metrics and org context in parallel
    const [metrics, org] = await Promise.all([
      fetchDigestData(integrationId, window),
      prisma.organisation.findUnique({
        where: { id: orgId },
        select: { businessContext: true, orgIdentity: true },
      }),
    ]);

    // Load anomalies detected during the covered week.
    // Use exclusive upper bound (lt next-day midnight) to capture the full
    // Sunday including any sub-second timestamps at 23:59:59.999.
    const weekStartDt = new Date(`${weekStart}T00:00:00Z`);
    const weekEndExclusive = new Date(`${weekEnd}T00:00:00Z`);
    weekEndExclusive.setUTCDate(weekEndExclusive.getUTCDate() + 1);

    const dbAnomalies = await prisma.insightAnomaly.findMany({
      where: {
        detectedAt: { gte: weekStartDt, lt: weekEndExclusive },
        job: { organisationId: orgId },
      },
      include: { job: { select: { insightType: true } } },
      orderBy: { detectedAt: 'asc' },
    });

    const anomalies: DigestAnomalySummary[] = dbAnomalies.map((a) => {
      const details = a.anomalyDetails as Record<string, unknown>;
      const zScore = Math.abs((details.zScore as number | undefined) ?? 0);
      return {
        insightType: a.job.insightType,
        direction: ((details.direction as string) ?? 'anomaly') as DigestAnomalySummary['direction'],
        summary: anomalySummaryLine(a.promptContext, a.job.insightType, details),
        anomalyId: a.id,
        severity: severityForZScore(zScore),
        detectedAt: a.detectedAt.toISOString().slice(0, 10),
      };
    });

    // Deterministic health score from the metrics — computed before the LLM so
    // the model explains a fixed number rather than inventing one.
    const healthScore = computeHealthScore(metrics, anomalies);

    // Generate digest via LLM
    const generated = await generateDigest(
      metrics,
      anomalies,
      {
        organisationId: orgId,
        businessContext: org?.businessContext,
        orgIdentity: org?.orgIdentity,
      },
      digestId,
      healthScore,
    );

    const weekOverWeek: DigestWeekOverWeek = {
      revenueChangePct: pctChange(metrics.totalRevenue, metrics.priorWeekRevenue),
      ordersChangePct: pctChange(metrics.totalOrders, metrics.priorWeekOrders),
      aovChangePct: pctChange(metrics.averageOrderValue, metrics.priorWeekAov),
      newlyRegisteredChangePct: pctChange(metrics.newlyRegisteredCustomers, metrics.priorWeekNewlyRegistered),
    };

    const summary: WeeklyDigestContent = {
      weekStart,
      weekEnd,
      headline: generated.headline,
      narrative: generated.narrative,
      healthScore: generated.healthScore,
      healthScoreRationale: generated.healthScoreRationale,
      topWins: generated.topWins,
      topConcerns: generated.topConcerns,
      weekOverWeek,
      anomalyCount: anomalies.length,
      anomalies,
      metrics,
    };

    // Persist digest summary and create linked recommendations atomically
    await prisma.$transaction(async (tx) => {
      await tx.weeklyDigest.update({
        where: { id: digestId },
        data: {
          status: 'SUCCEEDED',
          summary: summary as object,
          generatedByModel: generated.modelName,
          completedAt: new Date(),
        },
      });

      // Idempotency: a retry of this task (e.g. after a post-commit failure)
      // re-runs with the same digestId. Delete any OPEN opportunities already
      // linked to this digest before re-creating, so retries replace rather
      // than append duplicates. OPEN-only so we never clobber an opportunity
      // a user has already viewed/explored/dismissed/done.
      await tx.opportunity.deleteMany({
        where: { organisationId: orgId, sourceRef: digestId, status: 'OPEN' },
      });

      if (generated.opportunities.length > 0) {
        await tx.opportunity.createMany({
          data: generated.opportunities.map((o: OpportunityDraft) => ({
            organisationId: orgId,
            title: o.title,
            description: o.description,
            category: o.category as any,
            priority: o.priority,
            source: 'WEEKLY_DIGEST' as const,
            status: 'OPEN' as const,
            evidence: o.evidence as object[],
            dedupeKey: o.dedupeKey,
            sourceRef: digestId,
            generatedByModel: generated.modelName,
          })),
        });
      }
    });

    console.log(
      `[digest] succeeded: org=${orgId}, digestId=${digestId}, week=${weekStart}→${weekEnd}, healthScore=${summary.healthScore}, anomalies=${anomalies.length}, opportunities=${generated.opportunities.length}`,
    );

    // Email all org users. Runs after the transaction so a send failure cannot
    // roll back a fully-generated digest. The whole block is wrapped so that a
    // failure here (e.g. the recipients query) cannot rethrow and trigger the
    // task runner's retry — which would re-run runWeeklyDigest and duplicate the
    // already-committed recommendations. The digest is SUCCEEDED at this point;
    // a missed email is logged, not retried by re-running the generator.
    try {
      const recipients = await prisma.user.findMany({
        where: { organisationId: orgId },
        select: { email: true, name: true },
      });
      // Surface the single highest-priority opportunity in the email so the
      // merchant gets an actionable next step without clicking through.
      const topOpportunity = generated.opportunities
        .slice()
        .sort((a, b) => b.priority - a.priority)[0];
      let sent = 0;
      for (const u of recipients) {
        const { success } = await sendWeeklyDigestEmail(u.email, u.name, {
          weekStart: summary.weekStart,
          weekEnd: summary.weekEnd,
          headline: summary.headline,
          healthScore: summary.healthScore,
          topWins: summary.topWins,
          topConcerns: summary.topConcerns,
          currency: metrics.currency,
          totalRevenue: metrics.totalRevenue,
          revenueChangePct: weekOverWeek.revenueChangePct,
          topOpportunity: topOpportunity ? { title: topOpportunity.title, summary: topOpportunity.description } : null,
        });
        if (success) sent++;
      }
      if (sent < recipients.length) {
        console.warn(
          `[digest] email partial: org=${orgId}, digestId=${digestId}, sent=${sent}/${recipients.length}`,
        );
      }
    } catch (emailErr) {
      // Swallow — the digest itself succeeded; do not let email failures retry
      // the generator and duplicate recommendations.
      console.error(
        `[digest] email step failed (digest already succeeded): org=${orgId}, digestId=${digestId}`,
        emailErr,
      );
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[digest] failed: org=${orgId}, digestId=${digestId}`, err);

    await prisma.weeklyDigest
      .update({
        where: { id: digestId },
        data: { status: 'FAILED', error: errorMsg.slice(0, 500), completedAt: new Date() },
      })
      .catch((e: unknown) => console.error('[digest] failed to mark digest FAILED:', e));

    // Rethrow so the task runner's retry loop (maxAttempts: 3) can recover
    // from transient failures. Without this, every failure silently resolves
    // and no retry is ever attempted.
    throw err;
  }
}

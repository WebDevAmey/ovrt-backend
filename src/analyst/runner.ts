import { prisma } from '../prisma.js';
import type { InsightModule } from './modules/types.js';

/**
 * Async job runner for analyst pipelines.
 * Call this fire-and-forget from trigger.ts:
 *   runAnalystJob(jobId, module).catch((err) => console.error(...))
 *
 * Pipeline:
 *   1. Mark job RUNNING
 *   2. module.fetchData() → raw fact rows
 *   3. Persist factData on job
 *   4. module.detectAnomaly() → check for outlier
 *   5. If detected: persist InsightAnomaly (with promptContext) — silently.
 *      Anomalies no longer create hooks or send emails; the opportunity
 *      curation engine (src/analyst/opportunity/) turns them into curated,
 *      store-context-grounded Opportunities on its own schedule.
 *   6. Mark job SUCCEEDED (or FAILED)
 */
export async function runAnalystJob(
  jobId: string,
  module: InsightModule,
): Promise<void> {
  // Step 1: Mark RUNNING
  const job = await prisma.analystJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date() },
    select: {
      id: true,
      organisationId: true,
      sourceId: true,
      insightType: true,
    },
  });

  try {
    // Step 2: Fetch raw fact data from the module
    const rows = await module.fetchData(job.sourceId);

    // Step 3: Persist factData
    await prisma.analystJob.update({
      where: { id: job.id },
      data: { factData: rows as any },
    });

    // Step 4: Run outlier detection (pure function)
    const detection = module.detectAnomaly(rows);

    if (detection.detected) {
      // Step 5a: Build the module's prompt context. Persisted on the anomaly so
      // the opportunity curation engine can ground its suggestions in the same
      // formatted fact table the module produced.
      const context = module.buildPromptContext(rows, detection.anomaly);

      // Step 5b: Persist the InsightAnomaly. No hook, no email — anomalies are
      // raw signals; the curation engine decides what (if anything) becomes a
      // user-facing Opportunity.
      await prisma.insightAnomaly.create({
        data: {
          jobId: job.id,
          anomalyDetails: detection.anomaly as any,
          promptContext: context,
          detectedAt: new Date(),
        },
      });

      console.log(
        `[analyst] anomaly detected: org=${job.organisationId}, type=${job.insightType}, date=${detection.anomaly.date}, direction=${detection.anomaly.direction} (z=${detection.anomaly.zScore})`,
      );
    } else {
      console.log(
        `[analyst] no anomaly: org=${job.organisationId}, type=${job.insightType}`,
      );
    }

    // Step 6: Mark SUCCEEDED
    await prisma.analystJob.update({
      where: { id: job.id },
      data: { status: 'SUCCEEDED', completedAt: new Date() },
    });
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : String(err);
    console.error(
      `[analyst] job failed: org=${job.organisationId}, type=${job.insightType}, error=${errorMsg}`,
      err,
    );

    // Mark job as FAILED (best-effort; don't throw if this fails)
    await prisma.analystJob
      .update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          error: errorMsg.slice(0, 500),
        },
      })
      .catch((updateErr) =>
        console.error('[analyst] failed to mark job FAILED:', updateErr),
      );
  }
}

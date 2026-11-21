import { prisma } from '../prisma.js';
import { INSIGHT_MODULES } from './modules/index.js';
import { schedule, stopAll } from '../lib/scheduler.js';
import {
  initAnalystTaskRunner,
  getAnalystTaskRunnerOrNull,
  clearAnalystTaskRunner,
} from './runner-instance.js';
import { runSweep } from './sweep.js';
import { ANALYST_STALE_JOB_MS, BUSINESS_TIMEZONE } from './constants.js';
import { runDigestSweep, DIGEST_CRON_SCHEDULE } from './weekly-digest/index.js';
import { runOpportunityCurationSweep, OPPORTUNITY_CURATION_CRON_SCHEDULE } from './opportunity/index.js';

export function startAnalystRunner(): void {
  initAnalystTaskRunner(5, { maxAttempts: 3, baseDelayMs: 60_000 });
  console.log('[analyst] task runner started (concurrency=5, retry=3x exponential)');
}

export async function reapStaleAnalystJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - ANALYST_STALE_JOB_MS);
  const result = await prisma.analystJob.updateMany({
    where: {
      status: { in: ['QUEUED', 'RUNNING'] },
      createdAt: { lt: cutoff },
    },
    data: {
      status: 'FAILED',
      completedAt: new Date(),
      error: 'reaped: stale job (worker crash or redeploy)',
    },
  });

  if (result.count > 0) {
    console.log(`[analyst] reaped ${result.count} stale job(s) on startup`);
  }
}

export function startAnalystScheduler(): void {
  // Digest sweep first — Monday 06:00 IST, after all weekly modules have run.
  schedule(DIGEST_CRON_SCHEDULE, BUSINESS_TIMEZONE, 'digest-sweep', async () => {
    await runDigestSweep();
  });

  for (const module of INSIGHT_MODULES) {
    const { insightType, schedule: cronPattern } = module;
    schedule(cronPattern, BUSINESS_TIMEZONE, `sweep:${insightType}`, async () => {
      await runSweep(insightType);
    });
  }

  // Opportunity curation — daily tick; the 4-day-per-org cadence is enforced
  // inside the sweep via a marker AnalystJob (see opportunity/sweep.ts).
  schedule(OPPORTUNITY_CURATION_CRON_SCHEDULE, BUSINESS_TIMEZONE, 'opportunity-curation-sweep', async () => {
    await runOpportunityCurationSweep();
  });
}

export async function shutdownAnalyst(): Promise<void> {
  console.log('[analyst] shutdown starting...');
  stopAll();
  try {
    const runner = getAnalystTaskRunnerOrNull();
    if (runner) {
      await runner.drain();
      clearAnalystTaskRunner();
    }
    console.log('[analyst] shutdown complete');
  } catch (err) {
    console.error('[analyst] shutdown error:', err);
  }
}

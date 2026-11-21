import { prisma } from '../prisma.js';
import { initMiTaskRunner, getMiTaskRunnerOrNull, clearMiTaskRunner } from './runner-instance.js';

// QUEUED/RUNNING analyses older than this are treated as orphans from a crashed
// or redeployed worker and reaped to FAILED on startup. A real analysis (plan +
// up to 8 searches + synthesis) completes in a few minutes; 1 hour is a safe
// floor that won't reap an in-flight job during a rolling deploy.
const MI_STALE_JOB_MS = 60 * 60 * 1000; // 1 hour

/**
 * Reap orphaned analyses left at QUEUED/RUNNING by a crashed or redeployed
 * worker. Without this, the per-org "one active job" guard in routes.ts would
 * return 409 forever for that org — the analysis could never be re-run.
 */
export async function reapStaleMarketAnalyses(): Promise<void> {
  const cutoff = new Date(Date.now() - MI_STALE_JOB_MS);
  const result = await prisma.marketAnalysis.updateMany({
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
    console.log(`[market-intelligence] reaped ${result.count} stale analysis(es) on startup`);
  }
}

export function startMarketIntelligenceWorker(): void {
  initMiTaskRunner(3, { maxAttempts: 2, baseDelayMs: 30_000 });
  console.log('[market-intelligence] task runner started (concurrency=3, retry=2x exponential)');

  // Fire-and-forget: clear orphans from a previous process. Logged, never fatal.
  reapStaleMarketAnalyses().catch((err) =>
    console.error('[market-intelligence] reap startup failed:', err),
  );
}

export async function shutdownMarketIntelligenceWorker(): Promise<void> {
  const runner = getMiTaskRunnerOrNull();
  if (runner) {
    await runner.drain();
    clearMiTaskRunner();
  }
}

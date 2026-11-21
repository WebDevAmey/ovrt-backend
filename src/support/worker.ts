/**
 * Support agent worker
 * ====================
 * Drains QUEUED SupportAgentJob rows and runs them on a concurrency-limited
 * task runner (src/lib/task-runner.ts), the same machinery the analyst uses.
 * Jobs are enqueued event-driven by each channel's webhook (via
 * src/support/ingest.ts), so instead of a cron sweep we poll for QUEUED rows
 * on a short interval and dispatch them.
 *
 * Lifecycle (wired in src/index.ts):
 *   reapStaleSupportAgentJobs()  — on startup, fail orphaned RUNNING/QUEUED jobs
 *                                  (a crashed/redeployed worker would otherwise
 *                                  wedge the per-conversation active-job unique index).
 *   startSupportAgentWorker()    — begin the poll loop.
 *   shutdownSupportAgentWorker() — stop polling and drain in-flight jobs.
 */

import { prisma } from '../prisma.js';
import { createTaskRunner, type TaskRunner } from '../lib/task-runner.js';
import { runSupportAgentJob } from './runner.js';

const CONCURRENCY = 3;
const POLL_INTERVAL_MS = 5_000;
const STALE_JOB_MS = 60 * 60 * 1000; // 1h — real jobs finish in seconds
const BATCH = 20;

let runner: TaskRunner | null = null;
let pollTimer: NodeJS.Timeout | null = null;
// Ids currently dispatched, so an overlapping poll doesn't double-run a job.
const dispatched = new Set<string>();

export async function reapStaleSupportAgentJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_JOB_MS);
  // RUNNING jobs stuck for >1h are presumed orphaned by a crash or redeploy.
  // Reset them to QUEUED so the poll worker picks them up for a retry rather
  // than permanently losing the drafted reply. QUEUED jobs that aged past the
  // cutoff without ever starting are failed — they may have been blocked by a
  // per-conversation unique index that has since cleared.
  const requeued = await prisma.supportAgentJob.updateMany({
    where: { status: 'RUNNING', startedAt: { lt: cutoff } },
    data: { status: 'QUEUED', startedAt: null, error: null },
  });
  const failed = await prisma.supportAgentJob.updateMany({
    where: { status: 'QUEUED', createdAt: { lt: cutoff } },
    data: { status: 'FAILED', completedAt: new Date(), error: 'reaped: stale queued job (never started)' },
  });
  if (requeued.count > 0) console.log(`[support-agent] re-queued ${requeued.count} orphaned RUNNING job(s) on startup`);
  if (failed.count > 0) console.log(`[support-agent] failed ${failed.count} stale QUEUED job(s) on startup`);
}

async function poll(): Promise<void> {
  if (!runner) return;
  const queued = await prisma.supportAgentJob.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
    select: { id: true },
  });

  for (const { id } of queued) {
    if (dispatched.has(id)) continue;
    // Bug #2 fix: atomically claim the QUEUED→RUNNING transition here, before
    // dispatching, so queue-worker's independent event-driven path cannot also
    // call runSupportAgentJob for the same job. If the row was already claimed
    // (count=0), skip it — the other path owns it.
    const lock = await prisma.supportAgentJob.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (lock.count === 0) continue;
    dispatched.add(id);
    runner.run(`support-agent:${id}`, async () => {
      try {
        await runSupportAgentJob(id);
      } finally {
        dispatched.delete(id);
      }
    });
  }
}

export function startSupportAgentWorker(): void {
  runner = createTaskRunner(CONCURRENCY, { maxAttempts: 2, baseDelayMs: 30_000 });
  pollTimer = setInterval(() => {
    poll().catch((err) => console.error('[support-agent] poll error:', err));
  }, POLL_INTERVAL_MS);
  // Don't keep the process alive solely for polling.
  pollTimer.unref?.();
  console.log(`[support-agent] worker started (concurrency=${CONCURRENCY}, poll=${POLL_INTERVAL_MS}ms)`);
}

export async function shutdownSupportAgentWorker(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (runner) {
    await runner.drain();
    runner = null;
  }
  console.log('[support-agent] worker shut down');
}

import { initContentTaskRunner, getContentTaskRunnerOrNull, clearContentTaskRunner } from './runner-instance.js';

export function startContentWorker(): void {
  initContentTaskRunner(4, { maxAttempts: 1, baseDelayMs: 0 });
  console.log('[content] task runner started (concurrency=4)');
}

export async function shutdownContentWorker(): Promise<void> {
  const runner = getContentTaskRunnerOrNull();
  if (runner) {
    await runner.drain();
    clearContentTaskRunner();
  }
}

import { createTaskRunner, type TaskRunner, type RetryConfig } from '../lib/task-runner.js';

let runner: TaskRunner | null = null;

export function initContentTaskRunner(concurrency: number, retry: RetryConfig): TaskRunner {
  runner = createTaskRunner(concurrency, retry);
  return runner;
}

export function getContentTaskRunner(): TaskRunner {
  if (!runner) throw new Error('[content] task runner not initialized');
  return runner;
}

export function getContentTaskRunnerOrNull(): TaskRunner | null {
  return runner;
}

export function clearContentTaskRunner(): void {
  runner = null;
}

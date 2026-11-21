import { createTaskRunner, type TaskRunner, type RetryConfig } from '../lib/task-runner.js';

let runner: TaskRunner | null = null;

export function initMiTaskRunner(concurrency: number, retry: RetryConfig): TaskRunner {
  runner = createTaskRunner(concurrency, retry);
  return runner;
}

export function getMiTaskRunner(): TaskRunner {
  if (!runner) throw new Error('[market-intelligence] task runner not initialized');
  return runner;
}

export function getMiTaskRunnerOrNull(): TaskRunner | null {
  return runner;
}

export function clearMiTaskRunner(): void {
  runner = null;
}

import { createTaskRunner, type TaskRunner, type RetryConfig } from '../lib/task-runner.js';

let runner: TaskRunner | null = null;

export function initAnalystTaskRunner(concurrency: number, retry: RetryConfig): TaskRunner {
  runner = createTaskRunner(concurrency, retry);
  return runner;
}

export function getAnalystTaskRunner(): TaskRunner {
  if (!runner) throw new Error('[analyst] task runner not initialized');
  return runner;
}

export function getAnalystTaskRunnerOrNull(): TaskRunner | null {
  return runner;
}

export function clearAnalystTaskRunner(): void {
  runner = null;
}

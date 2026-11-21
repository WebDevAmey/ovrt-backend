export type RetryConfig = {
  maxAttempts: number;
  baseDelayMs: number;
};

export type TaskRunner = {
  run(label: string, fn: () => Promise<void>): void;
  drain(): Promise<void>;
};

export function createTaskRunner(concurrency: number, retry: RetryConfig): TaskRunner {
  let active = 0;
  const queue: Array<() => void> = [];
  const inFlight = new Set<Promise<void>>();

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      queue.shift()!();
    }
  }

  function run(label: string, fn: () => Promise<void>): void {
    const p = new Promise<void>((resolve) => {
      queue.push(async () => {
        try {
          let lastErr: unknown;
          for (let i = 0; i < retry.maxAttempts; i++) {
            try {
              await fn();
              return;
            } catch (err) {
              lastErr = err;
              if (i < retry.maxAttempts - 1) {
                const delay = retry.baseDelayMs * Math.pow(2, i);
                console.warn(
                  `[task-runner] ${label} attempt ${i + 1}/${retry.maxAttempts} failed, retry in ${delay}ms:`,
                  err,
                );
                await new Promise<void>((r) => setTimeout(r, delay));
              }
            }
          }
          console.error(
            `[task-runner] ${label} failed permanently after ${retry.maxAttempts} attempts:`,
            lastErr,
          );
        } finally {
          active--;
          resolve();
          next();
        }
      });
    });

    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
    next();
  }

  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight]);
    }
  }

  return { run, drain };
}

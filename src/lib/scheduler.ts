import * as nodeCron from 'node-cron';

const handles = new Set<nodeCron.ScheduledTask>();

export function schedule(
  pattern: string,
  tz: string,
  label: string,
  fn: () => Promise<void>,
): void {
  const task = nodeCron.schedule(
    pattern,
    () => {
      fn().catch((err) => console.error(`[scheduler] ${label} error:`, err));
    },
    { timezone: tz },
  );
  handles.add(task);
  console.log(`[scheduler] ${label} scheduled: cron=${pattern} tz=${tz}`);
}

export function stopAll(): void {
  for (const task of handles) {
    task.stop();
  }
  handles.clear();
  console.log('[scheduler] all cron jobs stopped');
}

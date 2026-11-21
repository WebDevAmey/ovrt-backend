/**
 * Inbound queue worker (channel-agnostic scheduler)
 * =================================================
 * The generic scheduling shell for inbound processing. It owns NO channel
 * specifics — it simply drains each registered InboundSource (see
 * channel-adapter.ts). Gmail registers `gmailInboundSource`; a future WhatsApp
 * source registers alongside it. The per-message pipeline lives in inbound.ts
 * and each channel's delivery model in its own module (e.g. src/gmail/inbound.ts).
 *
 * Two entry points:
 *   - startQueueListener(): periodic sweep that drains every source each tick,
 *     recovering any backlog left by a Pub/Sub outage or cold start.
 *   - drainAllInboundJobs(): one-shot full drain, used on startup before the
 *     first sweep tick fires.
 */

import { listInboundSources } from './channel-adapter.js';

/** Drain one source until it reports no more work. */
async function drainSource(processIngestJob: (jobId?: string) => Promise<boolean>): Promise<number> {
  let processed = 0;
  while (await processIngestJob()) processed++;
  return processed;
}

/** Drain every registered inbound source once. Returns total jobs processed. */
export async function drainAllInboundJobs(): Promise<number> {
  let total = 0;
  for (const source of listInboundSources()) {
    try {
      total += await drainSource((jobId) => source.processIngestJob(jobId));
    } catch (e) {
      console.error(`[queue-worker] drain failed for ${source.channelType}:`, e);
    }
  }
  return total;
}

/**
 * Start the periodic sweep. Each tick drains all registered sources so a
 * backlog doesn't require N × intervalMs to clear. Returns a stop function so
 * callers can clear the interval on shutdown.
 */
export function startQueueListener(intervalMs = 300000): () => void {
  const handle = setInterval(() => {
    drainAllInboundJobs().catch((e) => console.error('[queue-worker] sweep exception:', e));
  }, intervalMs);

  return () => clearInterval(handle);
}

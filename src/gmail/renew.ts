/**
 * Gmail watch renewal + reconciliation
 * ====================================
 * Gmail watches expire after 7 days. Re-watching resets the clock, so a daily
 * sweep keeps every tracked mailbox subscribed with comfortable margin.
 *
 * A mailbox is watched only when status=ACTIVE AND trackInbound=true. The sweep
 * reconciles both directions:
 *   - RENEW:  trackInbound=true connections whose watch is missing or expires
 *             within the 48h horizon → (re)register. Also does the first-ever watch.
 *   - STOP:   connections with a live watch (subscriptionExpiresAt set) that
 *             should no longer be tracked (trackInbound=false, or no longer
 *             ACTIVE) → call users.stop so Gmail stops publishing. The webhook
 *             also discards pushes from untracked mailboxes as a safety net,
 *             but stopping the watch is what actually cuts the traffic at the
 *             source.
 */

import { prisma } from '../prisma.js';
import { registerWatch, stopWatch } from './watch.js';
import { GoogleTokenError } from './oauth.js';

const RENEW_HORIZON_MS = 48 * 60 * 60 * 1000; // renew if expiring within 48h

export async function renewGmailWatches(): Promise<{
  renewed: number;
  stopped: number;
  failed: number;
}> {
  const horizon = new Date(Date.now() + RENEW_HORIZON_MS);

  // Connections we SHOULD be watching that need a (re)watch now.
  const due = await prisma.supportChannelConnection.findMany({
    where: {
      channelType: 'GMAIL',
      status: 'ACTIVE',
      trackInbound: true,
      OR: [{ subscriptionExpiresAt: null }, { subscriptionExpiresAt: { lt: horizon } }],
    },
    select: { id: true, externalAccountId: true },
  });

  // Connections we should NOT be watching but still have a live watch — turned
  // off (trackInbound=false) or deactivated while a watch was registered.
  const toStop = await prisma.supportChannelConnection.findMany({
    where: {
      channelType: 'GMAIL',
      subscriptionExpiresAt: { not: null },
      OR: [{ trackInbound: false }, { status: { not: 'ACTIVE' } }],
    },
    select: { id: true, externalAccountId: true },
  });

  let renewed = 0;
  let stopped = 0;
  let failed = 0;

  for (const connection of due) {
    try {
      const { expiration } = await registerWatch(connection.id);
      renewed++;
      console.log(
        `[gmail-renew] watched ${connection.externalAccountId} until ${expiration.toISOString()}`,
      );
    } catch (err) {
      failed++;
      // invalid_grant = user revoked consent. Mark the mailbox unhealthy so the
      // frontend can prompt a reconnect, and stop trying to watch it.
      const isRevoked = err instanceof GoogleTokenError && err.code === 'invalid_grant';
      await prisma.supportChannelConnection
        .update({
          where: { id: connection.id },
          data: {
            healthStatus: isRevoked ? 'reauth_required' : 'error',
            lastError: err instanceof Error ? err.message : String(err),
            lastHealthCheckAt: new Date(),
            ...(isRevoked ? { status: 'INACTIVE' } : {}),
          },
        })
        .catch(() => {});
      console.error(`[gmail-renew] failed for ${connection.externalAccountId}:`, err);
    }
  }

  for (const connection of toStop) {
    try {
      await stopWatch(connection.id);
      stopped++;
      console.log(`[gmail-renew] stopped watch for ${connection.externalAccountId} (untracked)`);
    } catch (err) {
      failed++;
      // Best-effort: even if users.stop fails, clear our watch state (incl. the
      // cursor — see stopWatch) so we don't keep retrying forever. The watch
      // lapses on its own within ≤7 days, and the webhook guard discards any
      // pushes in the meantime.
      await prisma.supportChannelConnection
        .update({
          where: { id: connection.id },
          data: { subscriptionExpiresAt: null, channelState: {}, syncCursor: null },
        })
        .catch(() => {});
      console.error(`[gmail-renew] stop failed for ${connection.externalAccountId}:`, err);
    }
  }

  if (due.length > 0 || toStop.length > 0) {
    console.log(
      `[gmail-renew] sweep complete: renewed=${renewed} stopped=${stopped} failed=${failed}`,
    );
  }
  return { renewed, stopped, failed };
}

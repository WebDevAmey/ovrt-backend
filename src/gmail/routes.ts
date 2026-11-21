/**
 * Gmail routes
 * ============
 * Mounted at /gmail in src/index.ts.
 *
 *   POST /gmail/push             public — Pub/Sub push endpoint.
 *   POST /gmail/watch/:id        internal admin — register/renew a watch.
 *   POST /gmail/renew            internal admin — run the renewal sweep.
 *
 * Conversation-lifecycle routes (approve, etc.) are channel-agnostic and live
 * under /support — see src/support/routes.ts.
 */

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { handleGmailPush } from './webhook.js';
import { registerWatch } from './watch.js';
import { renewGmailWatches } from './renew.js';

const gmail = new Hono();

// Public push endpoint — must NOT sit behind any service-token middleware.
gmail.post('/push', handleGmailPush);

// Internal admin guard. Fails closed: an unset secret disables the admin routes
// (with a loud warning so the misconfig is diagnosable rather than a silent
// confusing 401). The comparison is constant-time to avoid leaking the secret
// via response timing.
function requireAdminSecret(authHeader: string | undefined): boolean {
  const secret = process.env.GMAIL_ADMIN_SECRET;
  if (!secret) {
    console.warn('[gmail] GMAIL_ADMIN_SECRET is unset — admin routes (/watch, /renew) are disabled');
    return false;
  }
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (authHeader ?? '');
  return constantTimeEquals(provided, secret);
}

/** Length-safe constant-time string compare (timingSafeEqual throws on unequal lengths). */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

gmail.post('/watch/:id', async (c) => {
  if (!requireAdminSecret(c.req.header('authorization'))) return c.text('Unauthorized', 401);
  const id = c.req.param('id');
  try {
    const { historyId, expiration } = await registerWatch(id);
    return c.json({ ok: true, connectionId: id, historyId, expiration });
  } catch (err) {
    console.error('[gmail] watch failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'watch failed' }, 500);
  }
});

gmail.post('/renew', async (c) => {
  if (!requireAdminSecret(c.req.header('authorization'))) return c.text('Unauthorized', 401);
  try {
    const result = await renewGmailWatches();
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error('[gmail] renew failed:', err);
    return c.json({ error: err instanceof Error ? err.message : 'renew failed' }, 500);
  }
});

export { gmail };

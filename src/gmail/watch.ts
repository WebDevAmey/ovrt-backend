/**
 * Gmail users.watch registration
 * ==============================
 * Tells Gmail to publish change notifications for a mailbox to our Pub/Sub
 * topic. The watch returns the mailbox's current historyId (our starting
 * cursor) and an expiration (Gmail caps watches at 7 days). We persist both;
 * the renewal job re-watches daily so the watch never lapses.
 *
 * Required env var:
 *   GMAIL_PUBSUB_TOPIC — full topic name "projects/<PROJECT_ID>/topics/<TOPIC>"
 *   that the push subscription is attached to. This is the topic Gmail must be
 *   granted Publisher on (see GCP setup notes).
 */

import { prisma } from '../prisma.js';
import { resolveGmailConnection } from './credentials.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

function getTopicName(): string {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) throw new Error('GMAIL_PUBSUB_TOPIC env var is not set');
  return topic;
}

type WatchResponse = {
  historyId: string;
  /** ms-since-epoch as a string, per the Gmail API. */
  expiration: string;
};

/**
 * Register (or re-register) a watch on the mailbox. Idempotent: calling watch
 * again simply replaces the existing watch and resets the 7-day clock, which
 * is exactly what the daily renewal wants.
 *
 * We label='INBOX' so Gmail only notifies on inbox changes, not every label
 * mutation (sent, drafts, etc.). Adjust labelIds when the processing pass needs
 * a wider net.
 */
export async function registerWatch(connectionId: string): Promise<{
  historyId: string;
  expiration: Date;
}> {
  const conn = await resolveGmailConnection(connectionId);
  const topicName = getTopicName();

  const res = await fetch(`${GMAIL_API_BASE}/users/me/watch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${conn.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      topicName,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail watch failed (${res.status}) for ${conn.accountEmail}: ${detail}`);
  }

  const data = (await res.json()) as WatchResponse;
  const expiration = new Date(Number(data.expiration));

  await prisma.supportChannelConnection.update({
    where: { id: connectionId },
    data: { channelState: { watchTopic: topicName }, subscriptionExpiresAt: expiration },
  });

  // Seed syncCursor only on first watch so history.list has a starting
  // cursor. On renewal we keep the existing (lower) cursor — overwriting it
  // with the watch's current historyId would skip any changes that arrived
  // between the last processed notification and the renewal.
  await prisma.supportChannelConnection.updateMany({
    where: { id: connectionId, syncCursor: null },
    data: { syncCursor: data.historyId },
  });

  return { historyId: data.historyId, expiration };
}

/**
 * Stop notifications for a mailbox (disconnect, or trackInbound turned off).
 * Best-effort; a 404 just means there was no active watch.
 *
 * Clears syncCursor too: once we stop tracking we intentionally don't want
 * to retroactively process mail that arrives while off. If tracking is later
 * re-enabled, registerWatch reseeds the cursor to the mailbox's *current*
 * historyId (it only seeds when null), so we resume from "now" — not from the
 * stale pre-stop cursor, which would replay a backlog or 404 on too-old history.
 */
export async function stopWatch(connectionId: string): Promise<void> {
  const conn = await resolveGmailConnection(connectionId);
  const res = await fetch(`${GMAIL_API_BASE}/users/me/stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${conn.accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '');
    throw new Error(`gmail stop failed (${res.status}) for ${conn.accountEmail}: ${detail}`);
  }
  await prisma.supportChannelConnection.update({
    where: { id: connectionId },
    data: { subscriptionExpiresAt: null, channelState: {}, syncCursor: null },
  });
}

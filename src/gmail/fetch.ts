/**
 * Gmail message fetching + MIME body extraction
 * =============================================
 * Given a mailbox's stored historyId cursor, finds which messages were added
 * since then (history.list) and fetches each in full (messages.get), then walks
 * the MIME payload tree to pull out the human-readable body.
 *
 * Gmail bodies are base64url-encoded and can be nested arbitrarily deep inside
 * multipart/* containers (multipart/alternative for text+html, multipart/mixed
 * for attachments, multipart/related for inline images). We recurse the tree
 * and prefer text/plain, falling back to a tag-stripped text/html.
 */

import { resolveGmailConnection } from './credentials.js';
import { extractBody, getHeader, pickHeaders, type MessagePart } from './mime.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';

// --- Gmail REST response shapes (only the fields we read) -------------------

type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: MessagePart;
};
type HistoryRecord = {
  id: string;
  messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
};
type HistoryListResponse = {
  history?: HistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
};

// Headers we extract from each message. Two uses:
//  - classification: fingerprint bulk/marketing/automated mail.
//  - threading: message-id / in-reply-to / references let the agent's reply be
//    threaded correctly when it's sent (next pass).
// Lower-cased keys. Absent headers are simply omitted.
export const SIGNAL_HEADERS = [
  'message-id',
  'list-unsubscribe',
  'list-id',
  'precedence',
  'auto-submitted',
  'x-autoreply',
  'in-reply-to',
  'references',
  'return-path',
  'reply-to',
] as const;

export type ParsedMessage = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  /** Best-effort plain-text body (text/plain, or HTML stripped to text). */
  body: string;
  /** Gmail's own labels — carries CATEGORY_PROMOTIONS/SOCIAL/etc. */
  labelIds: string[];
  /** Lower-cased subset of headers used for classification (see SIGNAL_HEADERS). */
  headers: Record<string, string>;
};

// --- Gmail API calls --------------------------------------------------------

/**
 * Thrown when history.list is called with a startHistoryId Gmail no longer
 * retains (it keeps only ~1 week). The cursor cannot be resumed; the caller
 * must resync to a current historyId rather than retrying forever.
 */
export class GmailHistoryGoneError extends Error {
  constructor(public readonly startHistoryId: string) {
    super(`gmail history gone: startHistoryId ${startHistoryId} is older than Gmail retains (~1 week)`);
    this.name = 'GmailHistoryGoneError';
  }
}

/** HTTP error carrying the status code so callers can branch on it (e.g. 404). */
class GmailHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GmailHttpError';
  }
}

async function gmailGet<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GmailHttpError(res.status, `gmail GET ${path} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

// Labels that mean "this isn't a genuinely-new inbound mail we care about":
// the mailbox owner's own sent mail, drafts being saved, and Hangouts/Chat
// messages. We skip these so opening/replying never logs as a new arrival.
const NON_INBOUND_LABELS = new Set(['SENT', 'DRAFT', 'CHAT']);

/**
 * List message IDs added to the INBOX since `startHistoryId`, restricted to
 * genuinely-new inbound mail. Paginates through all history pages and returns
 * IDs in arrival order, de-duplicated (the same message can appear in multiple
 * history records).
 *
 * Two layers of narrowing, both cheap (no messages.get):
 *   - `labelId=INBOX` so Gmail only returns history touching the inbox, and
 *     `historyTypes=messageAdded` so only actual additions come back (read /
 *     star / archive changes are excluded server-side by Gmail).
 *   - we drop any added message whose own labelIds include SENT/DRAFT/CHAT.
 */
async function listAddedMessageIds(accessToken: string, startHistoryId: string): Promise<string[]> {
  const ids = new Set<string>();
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: 'messageAdded',
      labelId: 'INBOX',
    });
    if (pageToken) params.set('pageToken', pageToken);

    let page: HistoryListResponse;
    try {
      page = await gmailGet<HistoryListResponse>(
        accessToken,
        `/users/me/history?${params.toString()}`,
      );
    } catch (err) {
      // A 404 here means startHistoryId is older than Gmail retains — the cursor
      // is unrecoverable. Surface a typed error so the caller can resync instead
      // of failing the inbound job forever.
      if (err instanceof GmailHttpError && err.status === 404) {
        throw new GmailHistoryGoneError(startHistoryId);
      }
      throw err;
    }

    for (const record of page.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        const labels = added.message.labelIds ?? [];
        if (labels.some((l) => NON_INBOUND_LABELS.has(l))) continue;
        ids.add(added.message.id);
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return [...ids];
}

async function getMessage(accessToken: string, messageId: string): Promise<ParsedMessage> {
  const msg = await gmailGet<GmailMessage>(
    accessToken,
    `/users/me/messages/${messageId}?format=full`,
  );

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(msg.payload, 'From'),
    to: getHeader(msg.payload, 'To'),
    subject: getHeader(msg.payload, 'Subject'),
    date: getHeader(msg.payload, 'Date'),
    snippet: msg.snippet ?? '',
    body: extractBody(msg.payload),
    labelIds: msg.labelIds ?? [],
    headers: pickHeaders(msg.payload, SIGNAL_HEADERS),
  };
}

/**
 * Fetch all messages added to a mailbox since its stored cursor. The caller
 * passes the cursor that was current BEFORE this notification advanced it.
 *
 * Note: if startHistoryId is too old (Gmail only keeps ~1 week of history) the
 * API returns 404; this is surfaced as a typed GmailHistoryGoneError so the
 * caller can resync the cursor instead of retrying the dead cursor forever.
 */
export async function fetchNewMessages(
  connectionId: string,
  startHistoryId: string,
): Promise<ParsedMessage[]> {
  const conn = await resolveGmailConnection(connectionId);
  const ids = await listAddedMessageIds(conn.accessToken, startHistoryId);

  const messages: ParsedMessage[] = [];
  for (const id of ids) {
    messages.push(await getMessage(conn.accessToken, id));
  }
  return messages;
}

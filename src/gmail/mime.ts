/**
 * Gmail MIME body extraction (pure)
 * =================================
 * Walks a Gmail messages.get payload tree to pull out the human-readable body.
 * Gmail bodies are base64url-encoded and can be nested arbitrarily deep inside
 * multipart/* containers. We recurse, prefer text/plain, and fall back to a
 * tag-stripped text/html.
 *
 * Kept dependency-free (no Prisma / no fetch) so it's unit-testable in isolation.
 */

type MessagePartBody = { data?: string; size?: number; attachmentId?: string };
type MessageHeader = { name: string; value: string };

export type MessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: MessageHeader[];
  body?: MessagePartBody;
  parts?: MessagePart[];
};

function decodeBase64Url(data: string): string {
  // Gmail uses base64url (- and _); Buffer handles it directly.
  return Buffer.from(data, 'base64url').toString('utf8');
}

export function getHeader(part: MessagePart | undefined, name: string): string {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

/**
 * Pull a subset of headers into a lower-cased { name: value } map. Only the
 * requested names that are present are included. Used to hand the classifier
 * exactly the headers it scores, without copying the whole header list.
 */
export function pickHeaders(part: MessagePart | undefined, names: readonly string[]): Record<string, string> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out: Record<string, string> = {};
  for (const h of part?.headers ?? []) {
    const key = h.name.toLowerCase();
    if (wanted.has(key)) out[key] = h.value;
  }
  return out;
}

/** Strip tags + collapse whitespace so an HTML-only mail still logs readably. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Depth-first search of the MIME tree, collecting the first text/plain and the
 * first text/html body. Skips parts that are attachments (have a filename or an
 * attachmentId), since those aren't the message body.
 */
function collectBodies(part: MessagePart | undefined, acc: { plain?: string; html?: string }): void {
  if (!part) return;

  const isAttachment = !!part.filename || !!part.body?.attachmentId;
  if (!isAttachment && part.body?.data) {
    if (part.mimeType === 'text/plain' && acc.plain === undefined) {
      acc.plain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === 'text/html' && acc.html === undefined) {
      acc.html = decodeBase64Url(part.body.data);
    }
  }

  for (const child of part.parts ?? []) collectBodies(child, acc);
}

export function extractBody(payload: MessagePart | undefined): string {
  const acc: { plain?: string; html?: string } = {};
  collectBodies(payload, acc);
  if (acc.plain && acc.plain.trim()) return acc.plain.trim();
  if (acc.html) return htmlToText(acc.html);
  return '';
}

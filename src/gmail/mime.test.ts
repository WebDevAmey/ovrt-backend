import { describe, it, expect } from 'vitest';
import { extractBody, htmlToText, getHeader, type MessagePart } from './mime.js';

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

describe('extractBody', () => {
  it('reads a simple text/plain body', () => {
    const payload: MessagePart = {
      mimeType: 'text/plain',
      body: { data: b64url('Hello world') },
    };
    expect(extractBody(payload)).toBe('Hello world');
  });

  it('prefers text/plain over text/html in multipart/alternative', () => {
    const payload: MessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('plain version') } },
        { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
      ],
    };
    expect(extractBody(payload)).toBe('plain version');
  });

  it('falls back to stripped HTML when there is no text/plain', () => {
    const payload: MessagePart = {
      mimeType: 'text/html',
      body: { data: b64url('<p>Hi <b>there</b></p>') },
    };
    expect(extractBody(payload)).toBe('Hi there');
  });

  it('recurses into nested multipart/mixed → alternative', () => {
    const payload: MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('nested body') } },
            { mimeType: 'text/html', body: { data: b64url('<p>nested</p>') } },
          ],
        },
        // an attachment part — must be ignored
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att-1', size: 1234 },
        },
      ],
    };
    expect(extractBody(payload)).toBe('nested body');
  });

  it('ignores text parts that are actually attachments (have a filename)', () => {
    const payload: MessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64url('attached text') } },
        { mimeType: 'text/plain', body: { data: b64url('real body') } },
      ],
    };
    expect(extractBody(payload)).toBe('real body');
  });

  it('decodes base64url with - and _ characters', () => {
    // ">>?" encodes to "Pj4/" in base64 but "Pj4_" in base64url.
    const data = Buffer.from('>>?', 'utf8').toString('base64url');
    expect(data).toContain('_');
    const payload: MessagePart = { mimeType: 'text/plain', body: { data } };
    expect(extractBody(payload)).toBe('>>?');
  });

  it('returns empty string when there is no readable body', () => {
    expect(extractBody(undefined)).toBe('');
    expect(extractBody({ mimeType: 'multipart/mixed', parts: [] })).toBe('');
  });
});

describe('htmlToText', () => {
  it('converts <br> and block tags to newlines and unescapes entities', () => {
    const html = '<div>Line 1<br>Line 2</div><p>Para &amp; more</p>';
    expect(htmlToText(html)).toBe('Line 1\nLine 2\nPara & more');
  });

  it('drops style and script blocks entirely', () => {
    const html = '<style>.x{color:red}</style><p>visible</p><script>alert(1)</script>';
    expect(htmlToText(html)).toBe('visible');
  });
});

describe('getHeader', () => {
  it('matches header names case-insensitively', () => {
    const part: MessagePart = { headers: [{ name: 'Subject', value: 'Hello' }] };
    expect(getHeader(part, 'subject')).toBe('Hello');
    expect(getHeader(part, 'SUBJECT')).toBe('Hello');
  });

  it('returns empty string when absent or part missing', () => {
    expect(getHeader({ headers: [] }, 'From')).toBe('');
    expect(getHeader(undefined, 'From')).toBe('');
  });
});

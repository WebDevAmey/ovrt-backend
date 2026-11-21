import { describe, it, expect, vi, afterEach } from 'vitest';

// resolveGmailConnection touches the DB + OAuth; mock it so this stays a pure
// transport test that only exercises the history.list → GmailHistoryGoneError
// translation. The access token value is irrelevant (fetch is stubbed).
vi.mock('./credentials.js', () => ({
  resolveGmailConnection: vi.fn(async () => ({
    connectionId: 'conn_1',
    organisationId: 'org_1',
    accountEmail: 'shop@acme.com',
    accessToken: 'fake-token',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  })),
}));

const { fetchNewMessages, GmailHistoryGoneError } = await import('./fetch.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchNewMessages history.list 404 handling', () => {
  it('translates a 404 from history.list into a typed GmailHistoryGoneError carrying the cursor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('history record not found', { status: 404 }),
    );

    await expect(fetchNewMessages('conn_1', '99999')).rejects.toBeInstanceOf(GmailHistoryGoneError);
    await expect(fetchNewMessages('conn_1', '99999')).rejects.toMatchObject({ startHistoryId: '99999' });
  });

  it('propagates non-404 errors as-is (not as GmailHistoryGoneError)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('server error', { status: 500 }),
    );

    const err = await fetchNewMessages('conn_1', '12345').catch((e) => e);
    expect(err).not.toBeInstanceOf(GmailHistoryGoneError);
    expect(String(err)).toMatch(/500/);
  });

  it('returns no messages when history.list reports no additions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ historyId: '12346' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(fetchNewMessages('conn_1', '12345')).resolves.toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { ScoreboardClient, ScoreboardError, scoreboardUrlFor } from './scoreboardApi.js';

describe('scoreboardUrlFor', () => {
  it.each([
    ['wss://example.com/ws', 'https://example.com/api/solo'],
    ['ws://localhost:8080', 'http://localhost:8080/api/solo'],
    ['wss://relay.example.com:8443/', 'https://relay.example.com:8443/api/solo'],
    ['https://example.com/ws', 'https://example.com/api/solo'],
  ])('maps %s to %s', (relay, api) => {
    expect(scoreboardUrlFor(relay)).toBe(api);
  });

  it.each([['not a url'], ['ftp://example.com/']])('gives up on %s', (relay) => {
    expect(scoreboardUrlFor(relay)).toBeNull();
  });
});

const BASE = 'http://relay.test/api/solo';
const TICKET = { runId: 'a'.repeat(32), seed: 42, simVersion: 1, expiresAt: 1_800_000_000_000 };
const SUBMITTED = {
  id: 7,
  name: 'misha',
  score: 48,
  topMultiplier: 3,
  ticks: 2757,
  standing: { all: { rank: 1, total: 3 }, month: null },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that records its calls and answers with `respond`. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { fn, calls };
}

async function failure(promise: Promise<unknown>): Promise<ScoreboardError> {
  const err: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof ScoreboardError))
    throw new Error(`expected a ScoreboardError, got ${String(err)}`);
  return err;
}

describe('ScoreboardClient', () => {
  it('asks for a ticket with a POST', async () => {
    const f = fakeFetch(() => json(TICKET));
    expect(await new ScoreboardClient(BASE, f.fn).ticket()).toEqual(TICKET);
    expect(f.calls[0]?.url).toBe(`${BASE}/ticket`);
    expect(f.calls[0]?.init?.method).toBe('POST');
  });

  it('submits a run as JSON', async () => {
    const f = fakeFetch(() => json(SUBMITTED));
    const request = { runId: TICKET.runId, name: 'misha', replay: { version: 1 } };
    expect(await new ScoreboardClient(BASE, f.fn).submit(request)).toEqual(SUBMITTED);
    const init = f.calls[0]?.init;
    expect(f.calls[0]?.url).toBe(`${BASE}/submit`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual(request);
  });

  it('puts a board query in the URL', async () => {
    const board = { board: 'mult', period: 'month', month: '2026-09', total: 0, entries: [] };
    const f = fakeFetch(() => json(board));
    const client = new ScoreboardClient(BASE, f.fn);
    await client.scores({ board: 'mult', period: 'month', month: '2026-09', limit: 5 });
    await client.scores();
    expect(f.calls.map((c) => c.url)).toEqual([
      `${BASE}/scores?board=mult&period=month&month=2026-09&limit=5`,
      `${BASE}/scores`,
    ]);
  });

  it("turns the server's error into its code", async () => {
    const f = fakeFetch(() => json({ error: 'invalid_replay', message: 'nope' }, 422));
    const err = await failure(new ScoreboardClient(BASE, f.fn).ticket());
    expect(err.code).toBe('invalid_replay');
    expect(err.message).toBe('nope');
    expect(err.retryable).toBe(false);
  });

  it.each([
    ['an unreachable server', () => Promise.reject(new TypeError('fetch failed')), 'network'],
    ['a busy server', () => json({ error: 'busy', message: '' }, 503), 'busy'],
    ['a rate limit', () => json({ error: 'rate_limited', message: '' }, 429), 'rate_limited'],
    [
      "a proxy's error page",
      () => new Response('<h1>Bad Gateway</h1>', { status: 502 }),
      'internal',
    ],
    ['a malformed answer', () => json({ runId: 'nope' }), 'bad_response'],
  ])('counts %s as worth retrying', async (_label, respond, code) => {
    const fn = (): Promise<Response> => Promise.resolve(respond());
    const err = await failure(new ScoreboardClient(BASE, fn).ticket());
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(true);
  });

  const board = { board: 'score', period: 'all', month: null, total: 0, entries: [] };
  const entry = { rank: 1, id: 1, name: 'x', score: 1, topMultiplier: 0, ticks: 1, createdAt: 0 };
  it.each([
    ['an unknown board', { ...board, board: 'best' }],
    ['an unknown period', { ...board, period: 'week' }],
    ['a monthly board without its month', { ...board, period: 'month' }],
    ['an all-time board with a month', { ...board, month: '2026-09' }],
    // Past what a Date can hold, formatting the row would throw.
    ['a date out of range', { ...board, total: 1, entries: [{ ...entry, createdAt: 9e15 }] }],
  ])('rejects a board with %s', async (_label, body) => {
    const fn = (): Promise<Response> => Promise.resolve(json(body));
    const err = await failure(new ScoreboardClient(BASE, fn).scores());
    expect(err.code).toBe('bad_response');
  });
});

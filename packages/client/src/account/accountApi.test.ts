import { describe, expect, it } from 'vitest';
import { AccountClient, AccountError, apiOriginFor } from './accountApi.js';

const ACCOUNT = {
  handle: 'Misha',
  rating: 1500,
  provisional: true,
  wins: 0,
  losses: 0,
  draws: 0,
  createdAt: 1,
  renameAt: 1,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(respond: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return Promise.resolve(respond());
  };
  return { fn, calls };
}

describe('apiOriginFor', () => {
  it.each([
    ['wss://example.com/ws', 'https://example.com'],
    ['ws://localhost:8080', 'http://localhost:8080'],
  ])('maps %s to %s', (relay, origin) => {
    expect(apiOriginFor(relay)).toBe(origin);
  });

  it('gives up on a non-URL', () => {
    expect(apiOriginFor('nope')).toBeNull();
  });
});

describe('AccountClient', () => {
  it('registers with the guest token, and sends sessions as a Bearer header', async () => {
    const f = fakeFetch(() => json({ key: 'k', session: 's', account: ACCOUNT }));
    const client = new AccountClient('http://relay.test', f.fn);
    expect(await client.register('Misha', 'a'.repeat(32))).toMatchObject({ key: 'k' });
    expect(f.calls[0]!.url).toBe('http://relay.test/api/account/register');
    expect(JSON.parse(f.calls[0]!.init!.body as string)).toEqual({
      handle: 'Misha',
      guestToken: 'a'.repeat(32),
    });

    const me = fakeFetch(() => json({ account: ACCOUNT }));
    await new AccountClient('http://relay.test', me.fn).me('s3ss10n');
    expect(me.calls[0]!.url).toBe('http://relay.test/api/account/me');
    expect(me.calls[0]!.init!.headers).toEqual({ Authorization: 'Bearer s3ss10n' });
  });

  it('turns failures into AccountErrors with the server code', async () => {
    const taken = new AccountClient('http://relay.test', () =>
      Promise.resolve(json({ error: 'handle_taken', message: '"x" is taken' }, 409)),
    );
    await expect(taken.register('x')).rejects.toMatchObject({
      code: 'handle_taken',
      message: '"x" is taken',
    });
    const junk = new AccountClient('http://relay.test', () => Promise.resolve(json({ nope: 1 })));
    await expect(junk.login('k')).rejects.toMatchObject({ code: 'bad_response' });
    const down = new AccountClient('http://relay.test', () => Promise.reject(new Error('offline')));
    await expect(down.leaderboard()).rejects.toBeInstanceOf(AccountError);
  });

  it('reads the ladder, encoding handles in the path', async () => {
    const f = fakeFetch(() =>
      json({
        handle: 'Ｍ /x',
        rating: 1500,
        provisional: false,
        wins: 0,
        losses: 0,
        draws: 0,
        games: [],
      }),
    );
    await new AccountClient('http://relay.test', f.fn).player('Ｍ /x');
    expect(f.calls[0]!.url).toBe('http://relay.test/api/rating/player/%EF%BC%AD%20%2Fx');
  });
});

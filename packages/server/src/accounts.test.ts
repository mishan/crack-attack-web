import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KEY_WORDS,
  HANDLE_RENAME_INTERVAL_MS,
  SESSION_TTL_MS,
  normalizeAccountKey,
} from '@crack-attack/protocol';
import { MemoryAccountStore } from './accountStore.js';
import { AccountService, generateAccountKey, secretHash } from './accounts.js';
import { ApiError } from './apiError.js';
import { KEY_WORDS } from './wordlist.js';

const T0 = Date.UTC(2026, 8, 27);
const CLIENT = '203.0.113.7';

function setup(over: Partial<ConstructorParameters<typeof AccountService>[0]> = {}) {
  let ms = T0;
  let keys = 0;
  let sessions = 0;
  const store = new MemoryAccountStore();
  const log: string[] = [];
  const service = new AccountService({
    store,
    now: () => ms,
    newKey: () => wordsKey(++keys),
    newSession: () => (++sessions).toString(16).padStart(32, '0'),
    log: (line) => log.push(line),
    ...over,
  });
  return {
    store,
    service,
    log,
    advance: (by: number) => (ms += by),
    bearer: (session: string) => `Bearer ${session}`,
  };
}

/** A distinct valid key per n: eight words from the list. */
function wordsKey(n: number): string {
  return Array.from({ length: 8 }, (_, i) => KEY_WORDS[(n * 8 + i) % KEY_WORDS.length]!).join('-');
}

/** The ApiError a promise rejects with. */
async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('keys', () => {
  it('draw from 7,772 distinct lowercase words', () => {
    expect(KEY_WORDS).toHaveLength(7772);
    expect(new Set(KEY_WORDS).size).toBe(7772);
    for (const word of KEY_WORDS) expect(word).toMatch(/^[a-z]+$/);
  });

  it('are eight words, already in canonical form', () => {
    const key = generateAccountKey();
    expect(key.split('-')).toHaveLength(ACCOUNT_KEY_WORDS);
    for (const word of key.split('-')) expect(KEY_WORDS).toContain(word);
    expect(normalizeAccountKey(key)).toBe(key);
    expect(generateAccountKey()).not.toBe(key);
  });

  it('are stored as their SHA-256', () => {
    expect(secretHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('AccountService', () => {
  it('registers an account, logged in, with a key it keeps only the hash of', async () => {
    const { service, store, bearer } = setup();
    const created = await service.register(CLIENT, { handle: '  Misha ' });
    expect(created.account).toEqual({
      handle: 'Misha',
      rating: 1500,
      provisional: true,
      wins: 0,
      losses: 0,
      draws: 0,
      createdAt: T0,
      renameAt: T0,
    });
    expect(normalizeAccountKey(created.key)).toBe(created.key);
    expect(await store.accountByKey(created.key)).toBeNull();
    expect(await store.accountByKey(secretHash(created.key))).not.toBeNull();
    expect(await service.me(CLIENT, bearer(created.session))).toEqual({
      account: created.account,
    });
  });

  it("carries a guest's record into the new account", async () => {
    const { service, store } = setup();
    const guest = await store.createPlayer('a'.repeat(32), 'guest');
    await store.createPlayer('b'.repeat(32), 'rival');
    await store.recordResult(guest.token, 'b'.repeat(32));
    const { account } = await service.register(CLIENT, {
      handle: 'misha',
      guestToken: guest.token,
    });
    expect(account).toMatchObject({ wins: 1, losses: 0 });
  });

  it('refuses a taken handle, whatever its case or width', async () => {
    const { service } = setup();
    await service.register(CLIENT, { handle: 'Misha' });
    for (const handle of ['misha', 'MISHA', 'Ｍｉｓｈａ']) {
      const err = await refusal(service.register(CLIENT, { handle }));
      expect([err.status, err.code]).toEqual([409, 'handle_taken']);
    }
  });

  it('refuses a malformed request or an empty handle', async () => {
    const { service } = setup();
    expect((await refusal(service.register(CLIENT, { handle: '\u200b' }))).code).toBe('bad_handle');
    expect((await refusal(service.register(CLIENT, 'misha'))).code).toBe('bad_request');
  });

  it('logs in with the key, however it was typed', async () => {
    const { service, bearer } = setup();
    const { key, account } = await service.register(CLIENT, { handle: 'misha' });
    const typed = key.toUpperCase().replaceAll('-', ' ');
    const login = await service.login(CLIENT, { key: typed });
    expect(login.account).toEqual(account);
    expect((await service.me(CLIENT, bearer(login.session))).account.handle).toBe('misha');
    for (const bad of [wordsKey(999), 'not a key', '']) {
      const err = await refusal(service.login(CLIENT, { key: bad }));
      expect([err.status, err.code]).toEqual([401, 'bad_key']);
    }
  });

  it('refuses a missing, malformed, unknown or stale session', async () => {
    const { service, advance, bearer } = setup();
    const { session } = await service.register(CLIENT, { handle: 'misha' });
    for (const header of [undefined, '', 'Basic xyz', bearer('nope'), bearer('f'.repeat(32))]) {
      const err = await refusal(service.me(CLIENT, header));
      expect([err.status, err.code, err.headers['WWW-Authenticate']]).toEqual([
        401,
        'unauthorized',
        'Bearer',
      ]);
    }
    // A year of use keeps it alive; a year idle ends it.
    advance(SESSION_TTL_MS);
    expect(await service.me(CLIENT, `bearer  ${session}`)).toBeTruthy();
    advance(SESSION_TTL_MS + 1);
    expect((await refusal(service.me(CLIENT, bearer(session)))).code).toBe('unauthorized');
  });

  it('renames once per interval, to a free handle', async () => {
    const { service, advance, bearer } = setup();
    const a = await service.register(CLIENT, { handle: 'misha' });
    await service.register(CLIENT, { handle: 'bob' });
    const auth = bearer(a.session);
    // The same handle is no rename at all.
    expect((await service.rename(CLIENT, auth, { handle: 'misha' })).account.renameAt).toBe(T0);
    expect((await refusal(service.rename(CLIENT, auth, { handle: 'BOB' }))).code).toBe(
      'handle_taken',
    );
    const renamed = await service.rename(CLIENT, auth, { handle: 'Misha' });
    expect(renamed.account).toMatchObject({
      handle: 'Misha',
      renameAt: T0 + HANDLE_RENAME_INTERVAL_MS,
    });
    const soon = await refusal(service.rename(CLIENT, auth, { handle: 'mn' }));
    expect([soon.status, soon.code]).toEqual([409, 'rename_too_soon']);
    advance(HANDLE_RENAME_INTERVAL_MS);
    expect((await service.rename(CLIENT, auth, { handle: 'mn' })).account.handle).toBe('mn');
  });

  it('replaces the key, keeping only the session that asked', async () => {
    const { service, bearer } = setup();
    const created = await service.register(CLIENT, { handle: 'misha' });
    const other = await service.login(CLIENT, { key: created.key });
    const { key } = await service.replaceKey(CLIENT, bearer(created.session), {
      key: created.key,
    });
    expect(key).not.toBe(created.key);
    expect((await refusal(service.login(CLIENT, { key: created.key }))).code).toBe('bad_key');
    expect((await service.login(CLIENT, { key })).account.handle).toBe('misha');
    expect(await service.me(CLIENT, bearer(created.session))).toBeTruthy();
    expect((await refusal(service.me(CLIENT, bearer(other.session)))).code).toBe('unauthorized');
  });

  it("won't replace the key for a session alone, or with another account's key", async () => {
    const { service, bearer } = setup();
    const misha = await service.register(CLIENT, { handle: 'misha' });
    const bob = await service.register(CLIENT, { handle: 'bob' });
    const auth = bearer(misha.session);
    expect((await refusal(service.replaceKey(CLIENT, auth, {}))).code).toBe('bad_request');
    expect((await refusal(service.replaceKey(CLIENT, auth, { key: wordsKey(999) }))).code).toBe(
      'bad_key',
    );
    const other = await refusal(service.replaceKey(CLIENT, auth, { key: bob.key }));
    expect([other.code, other.message]).toEqual(['bad_key', "that key is another account's"]);
    // Nothing changed: both keys still log in.
    expect((await service.login(CLIENT, { key: misha.key })).account.handle).toBe('misha');
    expect((await service.login(CLIENT, { key: bob.key })).account.handle).toBe('bob');
  });

  it('logs out', async () => {
    const { service, bearer } = setup();
    const { session } = await service.register(CLIENT, { handle: 'misha' });
    expect(await service.logout(CLIENT, bearer(session))).toEqual({});
    expect((await refusal(service.me(CLIENT, bearer(session)))).code).toBe('unauthorized');
    // Again: nothing to end, and that's fine.
    expect(await service.logout(CLIENT, bearer(session))).toEqual({});
  });

  it('deletes an account only with its key, freeing the handle', async () => {
    const { service, bearer } = setup();
    const { key, session } = await service.register(CLIENT, { handle: 'misha' });
    expect(
      (await refusal(service.deleteAccount(CLIENT, undefined, { key: wordsKey(999) }))).code,
    ).toBe('bad_key');
    expect(await service.deleteAccount(CLIENT, bearer(session), { key })).toEqual({});
    expect((await refusal(service.me(CLIENT, bearer(session)))).code).toBe('unauthorized');
    expect((await refusal(service.login(CLIENT, { key }))).code).toBe('bad_key');
    expect((await service.register(CLIENT, { handle: 'misha' })).account.handle).toBe('misha');
  });

  it("won't delete another account with a session's request", async () => {
    const { service, bearer } = setup();
    const misha = await service.register(CLIENT, { handle: 'misha' });
    const bob = await service.register(CLIENT, { handle: 'bob' });
    const err = await refusal(
      service.deleteAccount(CLIENT, bearer(misha.session), { key: bob.key }),
    );
    expect(err.code).toBe('bad_key');
    expect((await service.login(CLIENT, { key: bob.key })).account.handle).toBe('bob');
    // Without a session, the key alone decides.
    expect(await service.deleteAccount(CLIENT, undefined, { key: bob.key })).toEqual({});
  });

  it('limits registrations per client, and logs a shared limit refusing', async () => {
    const { service, log } = setup({
      registerLimit: { capacity: 2, refillMs: 60_000 },
      registerGlobalLimit: { capacity: 3, refillMs: 60_000 },
    });
    await service.register(CLIENT, { handle: 'a' });
    await service.register(CLIENT, { handle: 'b' });
    const err = await refusal(service.register(CLIENT, { handle: 'c' }));
    expect([err.status, err.code, err.headers['Retry-After']]).toEqual([429, 'rate_limited', '60']);
    await service.register('198.51.100.1', { handle: 'c' });
    expect((await refusal(service.register('198.51.100.2', { handle: 'd' }))).status).toBe(429);
    expect(log).toEqual([
      expect.stringMatching(/registration limit shared by all clients refused 1/),
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { AccountState, STORAGE_TOKEN, type KeyValueStore } from './accountState.js';

const GUEST = 'a'.repeat(32);
const SESSION = 'b'.repeat(32);

function memory(
  initial: Record<string, string> = {},
): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('AccountState', () => {
  it('offers a guest token to a new account, and forgets the guest once registered', () => {
    const storage = memory({ [STORAGE_TOKEN]: GUEST });
    const state = new AccountState(storage);
    expect(state.handle).toBeNull();
    expect(state.session).toBeNull();
    expect(state.guestTokenForRegistration()).toBe(GUEST);
    state.registered(SESSION, 'Misha');
    expect([state.token, state.handle, state.session]).toEqual([SESSION, 'Misha', SESSION]);
    expect(state.guestTokenForRegistration()).toBeUndefined();
    state.loggedOut();
    expect([state.token, state.handle]).toEqual([null, null]);
  });

  it('keeps the guest through a log in, and returns to it on log out', () => {
    const state = new AccountState(memory({ [STORAGE_TOKEN]: GUEST }));
    state.loggedIn(SESSION, 'Misha');
    expect(state.session).toBe(SESSION);
    // Logging in again (another account) keeps the original guest.
    state.loggedIn('c'.repeat(32), 'Bob');
    state.loggedOut();
    expect([state.token, state.handle]).toEqual([GUEST, null]);
  });

  it("keeps the session when a relay welcomes it as a guest, until it's known to have ended", () => {
    const state = new AccountState(memory({ [STORAGE_TOKEN]: GUEST }));
    state.loggedIn(SESSION, 'Misha');
    expect(state.welcomed(SESSION, true)).toBe(false);
    expect(state.handle).toBe('Misha');
    // A relay that didn't know the session: nothing changes yet.
    expect(state.welcomed('d'.repeat(32), false)).toBe(true);
    expect([state.token, state.handle]).toEqual([SESSION, 'Misha']);
    // The account API says it has ended: back to the guest set aside.
    state.loggedOut();
    expect([state.token, state.handle]).toEqual([GUEST, null]);
    // A guest's own welcome just stores its token.
    expect(state.welcomed('e'.repeat(32), false)).toBe(false);
    expect(state.token).toBe('e'.repeat(32));
  });

  it('renames only while logged in', () => {
    const state = new AccountState(memory());
    state.renamed('x');
    expect(state.handle).toBeNull();
    state.registered(SESSION, 'Misha');
    state.renamed('Mish');
    expect(state.handle).toBe('Mish');
  });

  it('works, forgetfully, without storage or with storage that throws', () => {
    const none = new AccountState(null);
    none.registered(SESSION, 'Misha');
    expect(none.token).toBeNull();
    const broken = new AccountState({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => broken.loggedIn(SESSION, 'Misha')).not.toThrow();
    expect(broken.handle).toBeNull();
  });
});

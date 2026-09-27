/**
 * Conformance suite run against every AccountStore implementation, so a future
 * backend drops in with the same guarantees.
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryAccountStore,
  START_RATING,
  type AccountStore,
  type NewAccount,
} from './accountStore.js';
import { SqliteStore } from './sqliteStore.js';
import type { LobbyStore } from './store.js';

const T0 = Date.UTC(2026, 8, 27);
const DAY = 24 * 60 * 60 * 1000;
const hash = (s: string): string => s.padStart(64, '0');

const newAccount = (n: number, over: Partial<NewAccount> = {}): NewAccount => ({
  handle: `Player${n}`,
  handleFolded: `player${n}`,
  keyHash: hash(`k${n}`),
  sessionHash: hash(`s${n}`),
  createdAt: T0,
  ...over,
});

function conformance(name: string, make: () => AccountStore & LobbyStore): void {
  describe(name, () => {
    it('creates an account with a fresh rating and its first session', async () => {
      const store = make();
      const account = await store.createAccount(newAccount(1));
      expect(account).toEqual({
        id: expect.any(Number) as number,
        handle: 'Player1',
        handleFolded: 'player1',
        ...START_RATING,
        ratedAt: null,
        wins: 0,
        losses: 0,
        draws: 0,
        createdAt: T0,
        renamedAt: null,
        hidden: false,
      });
      expect(await store.accountByKey(hash('k1'))).toEqual(account);
      expect(await store.accountByHandle('player1')).toEqual(account);
      expect(await store.useSession(hash('s1'), T0 + 1, T0 - DAY)).toEqual(account);
      expect(await store.accountByKey(hash('nope'))).toBeNull();
      await store.close();
    });

    it('refuses a handle that folds like another, changing nothing', async () => {
      const store = make();
      await store.createAccount(newAccount(1));
      expect(await store.createAccount(newAccount(2, { handleFolded: 'player1' }))).toBeNull();
      expect(await store.accountByKey(hash('k2'))).toBeNull();
      expect(await store.useSession(hash('s2'), T0, 0)).toBeNull();
      await store.close();
    });

    it("moves a guest's record to the account and deletes the guest", async () => {
      const store = make();
      const guest = await store.createPlayer('a'.repeat(32), 'guest');
      await store.createPlayer('b'.repeat(32), 'rival');
      await store.recordResult(guest.token, 'b'.repeat(32));
      await store.recordResult(guest.token, 'b'.repeat(32));
      await store.recordResult('b'.repeat(32), guest.token);
      const account = await store.createAccount(newAccount(1, { guestToken: guest.token }));
      expect(account).toMatchObject({ wins: 2, losses: 1, draws: 0 });
      expect(await store.getPlayer(guest.token, 'guest')).toBeNull();
      // An unknown guest carries nothing.
      const other = await store.createAccount(newAccount(2, { guestToken: 'c'.repeat(32) }));
      expect(other).toMatchObject({ wins: 0, losses: 0 });
      await store.close();
    });

    it('keeps sessions until they go stale, end, or are pruned', async () => {
      const store = make();
      const { id } = (await store.createAccount(newAccount(1)))!;
      await store.addSession(hash('s2'), id, T0 + 10);
      // Used: its last use moves on, so it isn't stale an hour later.
      expect(await store.useSession(hash('s1'), T0 + DAY, T0)).not.toBeNull();
      expect(await store.useSession(hash('s1'), T0 + DAY + 1, T0 + DAY)).not.toBeNull();
      // Stale: refused, and gone for good.
      expect(await store.useSession(hash('s2'), T0 + DAY, T0 + 11)).toBeNull();
      expect(await store.useSession(hash('s2'), T0 + DAY, 0)).toBeNull();
      await store.endSession(hash('s1'));
      expect(await store.useSession(hash('s1'), T0 + DAY, 0)).toBeNull();

      await store.addSession(hash('s3'), id, T0);
      await store.addSession(hash('s4'), id, T0 + 5);
      expect(await store.pruneSessions(T0 + 1)).toBe(1);
      expect(await store.useSession(hash('s4'), T0 + 6, 0)).not.toBeNull();
      await store.close();
    });

    it('replaces a key, ending every other session', async () => {
      const store = make();
      const { id } = (await store.createAccount(newAccount(1)))!;
      const other = (await store.createAccount(newAccount(2)))!;
      await store.addSession(hash('s1b'), id, T0);
      await store.replaceKey(id, hash('k1new'), hash('s1'));
      expect(await store.accountByKey(hash('k1'))).toBeNull();
      expect((await store.accountByKey(hash('k1new')))?.id).toBe(id);
      expect(await store.useSession(hash('s1'), T0, 0)).not.toBeNull();
      expect(await store.useSession(hash('s1b'), T0, 0)).toBeNull();
      // Another account's sessions are untouched.
      expect((await store.useSession(hash('s2'), T0, 0))?.id).toBe(other.id);
      await store.close();
    });

    it('renames, keeping handles unique and renamedAt as asked', async () => {
      const store = make();
      const { id } = (await store.createAccount(newAccount(1)))!;
      await store.createAccount(newAccount(2));
      expect(await store.renameAccount(id, 'Player2', 'player2', T0 + 1)).toBeNull();
      // A new case of its own handle is fine.
      expect(await store.renameAccount(id, 'PLAYER1', 'player1', T0 + 1)).toMatchObject({
        handle: 'PLAYER1',
        renamedAt: T0 + 1,
      });
      expect(await store.renameAccount(id, 'Misha', 'misha', null)).toMatchObject({
        handle: 'Misha',
        handleFolded: 'misha',
        renamedAt: T0 + 1,
      });
      // The old handle is free again.
      expect(await store.createAccount(newAccount(3, { handleFolded: 'player1' }))).not.toBeNull();
      expect(await store.renameAccount(999, 'X', 'x', null)).toBeNull();
      await store.close();
    });

    it("never gives a deleted account's id to a new one", async () => {
      const store = make();
      await store.createAccount(newAccount(1));
      const newest = (await store.createAccount(newAccount(2)))!;
      await store.deleteAccount(newest.id);
      const next = (await store.createAccount(newAccount(3)))!;
      expect(next.id).toBeGreaterThan(newest.id);
      await store.close();
    });

    it('deletes an account with its sessions, freeing its handle and key', async () => {
      const store = make();
      const { id } = (await store.createAccount(newAccount(1)))!;
      expect(await store.deleteAccount(id)).toBe(true);
      expect(await store.deleteAccount(id)).toBe(false);
      expect(await store.accountByKey(hash('k1'))).toBeNull();
      expect(await store.useSession(hash('s1'), T0, 0)).toBeNull();
      expect(await store.createAccount(newAccount(1))).not.toBeNull();
      await store.close();
    });

    it('hides accounts and resets ratings', async () => {
      const store = make();
      const { id } = (await store.createAccount(newAccount(1)))!;
      expect(await store.setAccountHidden(id, true)).toBe(true);
      expect((await store.accountByHandle('player1'))?.hidden).toBe(true);
      expect(await store.setAccountHidden(id, false)).toBe(true);
      expect((await store.accountByHandle('player1'))?.hidden).toBe(false);
      expect(await store.resetRating(id)).toBe(true);
      expect(await store.accountByHandle('player1')).toMatchObject({
        ...START_RATING,
        ratedAt: null,
      });
      expect(await store.setAccountHidden(999, true)).toBe(false);
      expect(await store.resetRating(999)).toBe(false);
      await store.close();
    });
  });
}

conformance('MemoryAccountStore', () => new MemoryAccountStore());
conformance('SqliteStore (:memory:)', () => new SqliteStore(':memory:'));

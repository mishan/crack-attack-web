/**
 * Conformance suite run against every AccountStore implementation, so a future
 * backend drops in with the same guarantees.
 */

import { describe, expect, it } from 'vitest';
import {
  MemoryAccountStore,
  START_RATING,
  accountIdOf,
  accountKey,
  type AccountStore,
  type NewAccount,
  type NewRatedGame,
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

/** A rated game between accounts 1 and 2 (seat 0 winning), at `createdAt`. */
const game = (over: Partial<NewRatedGame> = {}): NewRatedGame => ({
  accountA: 1,
  accountB: 2,
  result: 'a',
  end: 'result',
  ticks: 2409,
  seed: 42,
  simVersion: 1,
  aBefore: { rating: 1500, rd: 350 },
  bBefore: { rating: 1500, rd: 350 },
  aAfter: { rating: 1662, rd: 290, volatility: 0.06 },
  bAfter: { rating: 1338, rd: 290, volatility: 0.06 },
  createdAt: T0,
  inputs: '{}',
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

    it('records casual games for accounts by their key, beside guests', async () => {
      const store = make();
      const { id } = (await store.createAccount(newAccount(1)))!;
      const guest = await store.createPlayer('a'.repeat(32), 'guest');
      await store.recordResult(accountKey(id), guest.token);
      await store.recordResult(guest.token, accountKey(id));
      await store.recordResult(accountKey(id), accountKey(999)); // unknown: ignored
      expect(await store.accountById(id)).toMatchObject({ wins: 2, losses: 1, draws: 0 });
      expect((await store.getPlayer(guest.token, 'guest'))?.record).toEqual({ wins: 1, losses: 1 });
      expect(accountIdOf(accountKey(id))).toBe(id);
      expect(accountIdOf(guest.token)).toBeNull();
      await store.close();
    });

    it('logs a rated game and applies it to both accounts', async () => {
      const store = make();
      await store.createAccount(newAccount(1));
      await store.createAccount(newAccount(2));
      const id = await store.recordRatedGame(game());
      expect(await store.accountById(1)).toMatchObject({
        rating: 1662,
        rd: 290,
        ratedAt: T0,
        wins: 1,
        losses: 0,
      });
      expect(await store.accountById(2)).toMatchObject({ rating: 1338, wins: 0, losses: 1 });
      await store.recordRatedGame(game({ result: 'draw', createdAt: T0 + 1 }));
      expect(await store.accountById(2)).toMatchObject({ draws: 1, ratedAt: T0 + 1 });

      const games = await store.ratedGames(2, 10);
      expect(games.map((g) => g.id)).toEqual([id + 1, id]);
      expect(games[1]).toEqual({
        id,
        accountA: 1,
        accountB: 2,
        handleA: 'Player1',
        handleB: 'Player2',
        result: 'a',
        end: 'result',
        ticks: 2409,
        aBefore: { rating: 1500, rd: 350 },
        aAfter: { rating: 1662, rd: 290 },
        bBefore: { rating: 1500, rd: 350 },
        bAfter: { rating: 1338, rd: 290 },
        createdAt: T0,
      });
      expect(await store.ratedGames(2, 1)).toHaveLength(1);
      // A deleted opponent shows as null; the game stays.
      await store.deleteAccount(1);
      expect((await store.ratedGames(2, 10))[0]?.handleA).toBeNull();
      await store.close();
    });

    it("counts a pair's rated games in either seat order since a time", async () => {
      const store = make();
      await store.recordRatedGame(game({ createdAt: T0 - 1 }));
      await store.recordRatedGame(game());
      await store.recordRatedGame(game({ accountA: 2, accountB: 1, createdAt: T0 + 5 }));
      await store.recordRatedGame(game({ accountB: 3 }));
      expect(await store.countRatedGames(1, 2, T0)).toBe(2);
      expect(await store.countRatedGames(2, 1, T0)).toBe(2);
      expect(await store.countRatedGames(1, 2, 0)).toBe(3);
      expect(await store.countRatedGames(2, 3, 0)).toBe(0);
      await store.close();
    });

    it('lists settled, active, visible accounts on the leaderboard, best first', async () => {
      const store = make();
      for (let n = 1; n <= 5; n++) await store.createAccount(newAccount(n));
      const settle = (id: number, rating: number, rd: number, at: number) =>
        store.recordRatedGame(
          game({
            accountA: id,
            accountB: 99,
            aAfter: { rating, rd, volatility: 0.06 },
            createdAt: at,
          }),
        );
      await settle(1, 1600, 80, T0);
      await settle(2, 1700, 80, T0);
      await settle(3, 1800, 200, T0); // provisional
      await settle(4, 1900, 80, T0 - 40 * DAY); // inactive
      await settle(5, 2000, 80, T0);
      await store.setAccountHidden(5, true);
      const board = await store.leaderboard(T0 - 30 * DAY, 110, 10);
      expect(board.map((a) => a.handle)).toEqual(['Player2', 'Player1']);
      expect(await store.leaderboard(T0 - 30 * DAY, 110, 1)).toHaveLength(1);
      await store.close();
    });

    it('drops old rated games inputs', async () => {
      const store = make();
      await store.recordRatedGame(game({ createdAt: T0 }));
      await store.recordRatedGame(game({ createdAt: T0 + DAY }));
      await store.recordRatedGame(game({ createdAt: T0, inputs: null }));
      expect(await store.dropGameInputs(T0 + 1)).toBe(1);
      expect(await store.dropGameInputs(T0 + 1)).toBe(0);
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

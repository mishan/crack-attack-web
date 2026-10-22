/**
 * accountStore.ts — persistence for accounts and their sessions (see
 * docs/RATING_PLAN.md). Abstract and async like {@link LobbyStore};
 * `SqliteStore` implements both on one database file, and
 * {@link MemoryAccountStore} serves tests.
 *
 * Keys and session tokens are stored only as hashes (see `accounts.ts`), so
 * the store never holds anything that logs in.
 */

import type { PlayerRecord, RatedGameEnd } from '@crack-attack/protocol';
import { MemoryStore } from './store.js';

/** A new account's rating: Glicko-2's defaults. */
export const START_RATING = { rating: 1500, rd: 350, volatility: 0.06 } as const;

/**
 * The lobby's record key for an account (see `LobbyStore.recordResult`): a
 * guest is keyed by its token, an account by this, which no token can equal.
 */
export function accountKey(id: number): string {
  return `account:${id}`;
}

/** The account id in an {@link accountKey}; null for a guest's token. */
export function accountIdOf(key: string): number | null {
  const m = /^account:([1-9]\d*)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** A rating and its deviation at one moment. */
export interface RatingSnapshot {
  rating: number;
  rd: number;
}

/** A rated game to log, with both accounts' ratings after it. */
export interface NewRatedGame {
  /** Seat 0's account. */
  accountA: number;
  accountB: number;
  result: 'a' | 'b' | 'draw';
  end: RatedGameEnd;
  ticks: number;
  seed: number;
  simVersion: number;
  aBefore: RatingSnapshot;
  bBefore: RatingSnapshot;
  /** The accounts' new ratings; volatility is stored on the account only. */
  aAfter: RatingSnapshot & { volatility: number };
  bAfter: RatingSnapshot & { volatility: number };
  /** Epoch ms; also each account's new `ratedAt`. */
  createdAt: number;
  /** Both seats' inputs as JSON (see `ratedGameInputs`), or null. */
  inputs: string | null;
}

/** A logged rated game, with each side's handle now (null for a deleted account). */
export interface StoredRatedGame {
  id: number;
  accountA: number;
  accountB: number;
  handleA: string | null;
  handleB: string | null;
  result: 'a' | 'b' | 'draw';
  end: RatedGameEnd;
  ticks: number;
  aBefore: RatingSnapshot;
  aAfter: RatingSnapshot;
  bBefore: RatingSnapshot;
  bAfter: RatingSnapshot;
  createdAt: number;
}

/** A stored account. */
export interface StoredAccount {
  id: number;
  handle: string;
  /** `foldHandle(handle)`: unique across accounts. */
  handleFolded: string;
  rating: number;
  rd: number;
  volatility: number;
  /** Epoch ms of the last rated game; null before the first. */
  ratedAt: number | null;
  wins: number;
  losses: number;
  draws: number;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last rename by its owner; null if never. */
  renamedAt: number | null;
  /** Kept off the leaderboard by a moderator. */
  hidden: boolean;
}

/** An account to create, with its first session. */
export interface NewAccount {
  handle: string;
  handleFolded: string;
  keyHash: string;
  sessionHash: string;
  /** Epoch ms: the account's creation and the session's first use. */
  createdAt: number;
  /** A guest whose W-L record moves to the account; the guest is deleted. */
  guestToken?: string | undefined;
}

export interface AccountStore {
  /**
   * Atomically create an account and its first session, moving the guest's
   * record over if there is one. Null if another account's handle folds the
   * same (nothing is changed then).
   */
  createAccount(account: NewAccount): Promise<StoredAccount | null>;
  accountByKey(keyHash: string): Promise<StoredAccount | null>;
  accountByHandle(handleFolded: string): Promise<StoredAccount | null>;
  addSession(sessionHash: string, accountId: number, now: number): Promise<void>;
  /**
   * The account a session belongs to, marking the session used at `now`. Null
   * if the session is unknown, or was last used before `staleBefore` (it's
   * deleted then).
   */
  useSession(sessionHash: string, now: number, staleBefore: number): Promise<StoredAccount | null>;
  endSession(sessionHash: string): Promise<void>;
  /** Delete sessions last used before `before`; returns how many. */
  pruneSessions(before: number): Promise<number>;
  /** Replace an account's key, ending every session but `keepSessionHash`. */
  replaceKey(accountId: number, keyHash: string, keepSessionHash: string): Promise<void>;
  /**
   * Change an account's handle, setting `renamedAt` (null leaves it: a
   * moderator's rename doesn't use up the owner's). Null if another account's
   * handle folds the same, or the account is gone.
   */
  renameAccount(
    accountId: number,
    handle: string,
    handleFolded: string,
    renamedAt: number | null,
  ): Promise<StoredAccount | null>;
  /** Delete an account and its sessions; false if there was none. */
  deleteAccount(accountId: number): Promise<boolean>;
  setAccountHidden(accountId: number, hidden: boolean): Promise<boolean>;
  accountById(accountId: number): Promise<StoredAccount | null>;
  /**
   * Atomically log a rated game and apply it to both accounts: the new
   * ratings, `ratedAt`, and a win, loss or draw each. Returns the game's id.
   * An account that no longer exists is left alone; the game is logged anyway.
   */
  recordRatedGame(game: NewRatedGame): Promise<number>;
  /** Rated games between two accounts (either seat) logged at or after `since`. */
  countRatedGames(accountA: number, accountB: number, since: number): Promise<number>;
  /**
   * The leaderboard: visible accounts with `rd <= maxRd` and a rated game at
   * or after `activeSince`, best rating first (ties: the older account).
   */
  leaderboard(activeSince: number, maxRd: number, limit: number): Promise<StoredAccount[]>;
  /** An account's rated games, newest first. */
  ratedGames(accountId: number, limit: number): Promise<StoredRatedGame[]>;
  /** Drop the inputs of rated games logged before `before`; returns how many. */
  dropGameInputs(before: number): Promise<number>;
  /** Put an account's rating back to {@link START_RATING}, as if never rated; false if there was none. */
  resetRating(accountId: number): Promise<boolean>;
}

interface Session {
  accountId: number;
  lastUsedAt: number;
}

/**
 * In-memory accounts, for tests. A {@link MemoryStore} too, so a guest's
 * record can move to a new account as it does in SQLite.
 */
export class MemoryAccountStore extends MemoryStore implements AccountStore {
  private readonly accounts = new Map<number, StoredAccount & { keyHash: string }>();
  private readonly sessions = new Map<string, Session>();
  private readonly games: (NewRatedGame & { id: number })[] = [];
  private nextId = 1;

  /** A casual game: guests by token, accounts by {@link accountKey}. */
  override recordResult(winnerKey: string, loserKey: string): Promise<void> {
    const winner = this.accounts.get(accountIdOf(winnerKey) ?? 0);
    const loser = this.accounts.get(accountIdOf(loserKey) ?? 0);
    if (winner) winner.wins++;
    if (loser) loser.losses++;
    return super.recordResult(winnerKey, loserKey);
  }

  accountById(accountId: number): Promise<StoredAccount | null> {
    const row = this.accounts.get(accountId);
    return Promise.resolve(row ? copy(row) : null);
  }

  recordRatedGame(game: NewRatedGame): Promise<number> {
    const id = this.games.length + 1;
    this.games.push({ ...game, id });
    const apply = (accountId: number, after: NewRatedGame['aAfter'], score: number): void => {
      const row = this.accounts.get(accountId);
      if (!row) return;
      Object.assign(row, after, { ratedAt: game.createdAt });
      if (score === 1) row.wins++;
      else if (score === 0) row.losses++;
      else row.draws++;
    };
    const scoreA = game.result === 'a' ? 1 : game.result === 'b' ? 0 : 0.5;
    apply(game.accountA, game.aAfter, scoreA);
    apply(game.accountB, game.bAfter, 1 - scoreA);
    return Promise.resolve(id);
  }

  countRatedGames(accountA: number, accountB: number, since: number): Promise<number> {
    const pair = (g: NewRatedGame): boolean =>
      (g.accountA === accountA && g.accountB === accountB) ||
      (g.accountA === accountB && g.accountB === accountA);
    return Promise.resolve(this.games.filter((g) => pair(g) && g.createdAt >= since).length);
  }

  leaderboard(activeSince: number, maxRd: number, limit: number): Promise<StoredAccount[]> {
    const rows = [...this.accounts.values()]
      .filter((a) => !a.hidden && a.rd <= maxRd && a.ratedAt !== null && a.ratedAt >= activeSince)
      .sort((x, y) => y.rating - x.rating || x.id - y.id);
    return Promise.resolve(rows.slice(0, limit).map(copy));
  }

  ratedGames(accountId: number, limit: number): Promise<StoredRatedGame[]> {
    const handle = (id: number): string | null => this.accounts.get(id)?.handle ?? null;
    const rows = this.games
      .filter((g) => g.accountA === accountId || g.accountB === accountId)
      .sort((x, y) => y.createdAt - x.createdAt || y.id - x.id)
      .slice(0, limit)
      .map((g) => ({
        id: g.id,
        accountA: g.accountA,
        accountB: g.accountB,
        handleA: handle(g.accountA),
        handleB: handle(g.accountB),
        result: g.result,
        end: g.end,
        ticks: g.ticks,
        aBefore: g.aBefore,
        aAfter: { rating: g.aAfter.rating, rd: g.aAfter.rd },
        bBefore: g.bBefore,
        bAfter: { rating: g.bAfter.rating, rd: g.bAfter.rd },
        createdAt: g.createdAt,
      }));
    return Promise.resolve(rows);
  }

  dropGameInputs(before: number): Promise<number> {
    let n = 0;
    for (const g of this.games) {
      if (g.inputs !== null && g.createdAt < before) {
        g.inputs = null;
        n++;
      }
    }
    return Promise.resolve(n);
  }

  /** A logged game's inputs (for tests). */
  gameInputs(id: number): string | null {
    return this.games[id - 1]?.inputs ?? null;
  }

  createAccount(account: NewAccount): Promise<StoredAccount | null> {
    if (this.byFolded(account.handleFolded)) return Promise.resolve(null);
    let record: PlayerRecord = { wins: 0, losses: 0 };
    if (account.guestToken !== undefined) {
      const guest = this.players.get(account.guestToken);
      if (guest) {
        record = { ...guest.record };
        this.players.delete(account.guestToken);
      }
    }
    const row = {
      id: this.nextId++,
      handle: account.handle,
      handleFolded: account.handleFolded,
      keyHash: account.keyHash,
      ...START_RATING,
      ratedAt: null,
      wins: record.wins,
      losses: record.losses,
      draws: 0,
      createdAt: account.createdAt,
      renamedAt: null,
      hidden: false,
    };
    this.accounts.set(row.id, row);
    this.sessions.set(account.sessionHash, { accountId: row.id, lastUsedAt: account.createdAt });
    return Promise.resolve(copy(row));
  }

  accountByKey(keyHash: string): Promise<StoredAccount | null> {
    for (const row of this.accounts.values()) {
      if (row.keyHash === keyHash) return Promise.resolve(copy(row));
    }
    return Promise.resolve(null);
  }

  accountByHandle(handleFolded: string): Promise<StoredAccount | null> {
    const row = this.byFolded(handleFolded);
    return Promise.resolve(row ? copy(row) : null);
  }

  addSession(sessionHash: string, accountId: number, now: number): Promise<void> {
    this.sessions.set(sessionHash, { accountId, lastUsedAt: now });
    return Promise.resolve();
  }

  useSession(sessionHash: string, now: number, staleBefore: number): Promise<StoredAccount | null> {
    const session = this.sessions.get(sessionHash);
    const row = session && this.accounts.get(session.accountId);
    if (!session || !row) return Promise.resolve(null);
    if (session.lastUsedAt < staleBefore) {
      this.sessions.delete(sessionHash);
      return Promise.resolve(null);
    }
    session.lastUsedAt = now;
    return Promise.resolve(copy(row));
  }

  endSession(sessionHash: string): Promise<void> {
    this.sessions.delete(sessionHash);
    return Promise.resolve();
  }

  pruneSessions(before: number): Promise<number> {
    let n = 0;
    for (const [hash, session] of this.sessions) {
      if (session.lastUsedAt < before) {
        this.sessions.delete(hash);
        n++;
      }
    }
    return Promise.resolve(n);
  }

  replaceKey(accountId: number, keyHash: string, keepSessionHash: string): Promise<void> {
    const row = this.accounts.get(accountId);
    if (row) row.keyHash = keyHash;
    for (const [hash, session] of this.sessions) {
      if (session.accountId === accountId && hash !== keepSessionHash) this.sessions.delete(hash);
    }
    return Promise.resolve();
  }

  renameAccount(
    accountId: number,
    handle: string,
    handleFolded: string,
    renamedAt: number | null,
  ): Promise<StoredAccount | null> {
    const row = this.accounts.get(accountId);
    const holder = this.byFolded(handleFolded);
    if (!row || (holder && holder.id !== accountId)) return Promise.resolve(null);
    row.handle = handle;
    row.handleFolded = handleFolded;
    if (renamedAt !== null) row.renamedAt = renamedAt;
    return Promise.resolve(copy(row));
  }

  deleteAccount(accountId: number): Promise<boolean> {
    for (const [hash, session] of this.sessions) {
      if (session.accountId === accountId) this.sessions.delete(hash);
    }
    return Promise.resolve(this.accounts.delete(accountId));
  }

  setAccountHidden(accountId: number, hidden: boolean): Promise<boolean> {
    const row = this.accounts.get(accountId);
    if (row) row.hidden = hidden;
    return Promise.resolve(row !== undefined);
  }

  resetRating(accountId: number): Promise<boolean> {
    const row = this.accounts.get(accountId);
    if (row) Object.assign(row, START_RATING, { ratedAt: null });
    return Promise.resolve(row !== undefined);
  }

  private byFolded(handleFolded: string): (StoredAccount & { keyHash: string }) | undefined {
    for (const row of this.accounts.values()) if (row.handleFolded === handleFolded) return row;
    return undefined;
  }
}

function copy(row: StoredAccount & { keyHash: string }): StoredAccount {
  const { keyHash: _keyHash, ...account } = row;
  return account;
}

/**
 * accountStore.ts — persistence for accounts and their sessions (see
 * docs/RATING_PLAN.md). Abstract and async like {@link LobbyStore};
 * `SqliteStore` implements both on one database file, and
 * {@link MemoryAccountStore} serves tests.
 *
 * Keys and session tokens are stored only as hashes (see `accounts.ts`), so
 * the store never holds anything that logs in.
 */

import type { PlayerRecord } from '@crack-attack/protocol';
import { MemoryStore } from './store.js';

/** A new account's rating: Glicko-2's defaults. */
export const START_RATING = { rating: 1500, rd: 350, volatility: 0.06 } as const;

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
  private nextId = 1;

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

/**
 * sqliteStore.ts — SQLite-backed {@link LobbyStore}, on Node's built-in
 * `node:sqlite`. No native add-on to install, so the relay bundles into one
 * file that runs with plain `node` (see `scripts/bundle.mjs`).
 *
 * One file on disk; the synchronous driver is wrapped in the async store
 * interface so a network-backed store (Redis, ...) can swap in unchanged.
 * Replaces the original's per-user `~/.crack-attack/` record files. It's plain
 * SQLite, so a database written by the earlier better-sqlite3 store opens as is.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { LobbyStore, StoredPlayer } from './store.js';

interface PlayerRow {
  token: string;
  name: string;
  wins: number;
  losses: number;
}

export class SqliteStore implements LobbyStore {
  private readonly db: DatabaseSync;
  // Prepared once and reused for every call.
  private readonly selectPlayer: StatementSync;
  private readonly renamePlayer: StatementSync;
  private readonly insertPlayer: StatementSync;
  private readonly addWin: StatementSync;
  private readonly addLoss: StatementSync;

  /** @param path Database file path, or ':memory:' for an ephemeral store. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL lets readers (a backup, say) run alongside the relay's writes; on a
    // lock, wait briefly instead of failing straight away with SQLITE_BUSY.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        token  TEXT PRIMARY KEY,
        name   TEXT NOT NULL,
        wins   INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
    this.selectPlayer = this.db.prepare(
      'SELECT token, name, wins, losses FROM players WHERE token = ?',
    );
    this.renamePlayer = this.db.prepare('UPDATE players SET name = ? WHERE token = ?');
    this.insertPlayer = this.db.prepare('INSERT INTO players (token, name) VALUES (?, ?)');
    this.addWin = this.db.prepare('UPDATE players SET wins = wins + 1 WHERE token = ?');
    this.addLoss = this.db.prepare('UPDATE players SET losses = losses + 1 WHERE token = ?');
  }

  getPlayer(token: string, name: string): Promise<StoredPlayer | null> {
    const row = this.selectPlayer.get(token) as PlayerRow | undefined;
    if (!row) return Promise.resolve(null);
    if (row.name !== name) this.renamePlayer.run(name, token);
    return Promise.resolve({
      token: row.token,
      name,
      record: { wins: row.wins, losses: row.losses },
    });
  }

  createPlayer(token: string, name: string): Promise<StoredPlayer> {
    this.insertPlayer.run(token, name);
    return Promise.resolve({ token, name, record: { wins: 0, losses: 0 } });
  }

  recordResult(winnerToken: string, loserToken: string): Promise<void> {
    // Both sides of a result, or neither.
    this.db.exec('BEGIN');
    try {
      this.addWin.run(winnerToken);
      this.addLoss.run(loserToken);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

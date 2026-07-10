/**
 * sqliteStore.ts — SQLite-backed {@link LobbyStore} (better-sqlite3).
 *
 * One file on disk; the synchronous driver is wrapped in the async store
 * interface so a network-backed store (Redis, ...) can swap in unchanged.
 * Replaces the original's per-user `~/.crack-attack/` record files.
 */

import Database from 'better-sqlite3';
import type { LobbyStore, StoredPlayer } from './store.js';

export class SqliteStore implements LobbyStore {
  private readonly db: Database.Database;

  /** @param path Database file path, or ':memory:' for an ephemeral store. */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        token  TEXT PRIMARY KEY,
        name   TEXT NOT NULL,
        wins   INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `);
  }

  getPlayer(token: string, name: string): Promise<StoredPlayer | null> {
    const row = this.db
      .prepare<[string], { token: string; name: string; wins: number; losses: number }>(
        'SELECT token, name, wins, losses FROM players WHERE token = ?',
      )
      .get(token);
    if (!row) return Promise.resolve(null);
    if (row.name !== name) {
      this.db.prepare('UPDATE players SET name = ? WHERE token = ?').run(name, token);
    }
    return Promise.resolve({
      token: row.token,
      name,
      record: { wins: row.wins, losses: row.losses },
    });
  }

  createPlayer(token: string, name: string): Promise<StoredPlayer> {
    this.db.prepare('INSERT INTO players (token, name) VALUES (?, ?)').run(token, name);
    return Promise.resolve({ token, name, record: { wins: 0, losses: 0 } });
  }

  recordResult(winnerToken: string, loserToken: string): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE players SET wins = wins + 1 WHERE token = ?').run(winnerToken);
      this.db.prepare('UPDATE players SET losses = losses + 1 WHERE token = ?').run(loserToken);
    });
    tx();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

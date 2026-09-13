/**
 * sqliteStore.ts — SQLite-backed {@link LobbyStore} and {@link ScoreStore}, on
 * Node's built-in `node:sqlite`. No native add-on to install, so the relay
 * bundles into one file that runs with plain `node` (see `scripts/bundle.mjs`).
 *
 * One file on disk; the synchronous driver is wrapped in the async store
 * interfaces so a network-backed store (Redis, ...) can swap in unchanged.
 * Replaces the original's per-user `~/.crack-attack/` record files. It's plain
 * SQLite, so a database written by the earlier better-sqlite3 store opens as
 * is, and older schemas upgrade in place (see {@link MIGRATIONS}).
 */

import type { ScoreBoard, SoloStanding } from '@crack-attack/protocol';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  NewSoloScore,
  ScoreStore,
  SoloTicket,
  StoredSoloScore,
  TimeRange,
} from './scoreStore.js';
import type { LobbyStore, StoredPlayer } from './store.js';

interface PlayerRow {
  token: string;
  name: string;
  wins: number;
  losses: number;
}

interface TicketRow {
  run_id: string;
  seed: number;
  sim_version: number;
  issued_at: number;
}

interface ScoreRow {
  id: number;
  run_id: string;
  name: string;
  score: number;
  top_multiplier: number;
  ticks: number;
  sim_version: number;
  created_at: number;
  hidden: number;
}

/**
 * Schema upgrades, in order: entry `i` takes a database from `user_version` i
 * to i + 1. Version 0 is the original schema (just `players`, created above
 * them), so a database from before migrations existed upgrades like a new one.
 * Append only — never edit an entry that has shipped.
 */
const MIGRATIONS: readonly string[] = [
  // 1: the solo scoreboard.
  `
  CREATE TABLE solo_tickets (
    run_id      TEXT PRIMARY KEY,
    seed        INTEGER NOT NULL,
    sim_version INTEGER NOT NULL,
    issued_at   INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX solo_tickets_issued ON solo_tickets (issued_at);
  CREATE TABLE solo_scores (
    id             INTEGER PRIMARY KEY,
    run_id         TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    score          INTEGER NOT NULL,
    top_multiplier INTEGER NOT NULL,
    ticks          INTEGER NOT NULL,
    sim_version    INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    replay         TEXT NOT NULL,
    hidden         INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX solo_scores_by_score ON solo_scores (score DESC, id);
  CREATE INDEX solo_scores_by_mult ON solo_scores (top_multiplier DESC, score DESC, id);
  CREATE INDEX solo_scores_by_time ON solo_scores (created_at);
  `,
];

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

const SCORE_COLUMNS =
  'id, run_id, name, score, top_multiplier, ticks, sim_version, created_at, hidden';
/** SQL condition: the run in table `t` is visible and created in `[:from, :to)`. */
const inRange = (t: string): string =>
  `${t}.hidden = 0 AND ${t}.created_at >= :from AND ${t}.created_at < :to`;

export class SqliteStore implements LobbyStore, ScoreStore {
  private readonly db: DatabaseSync;
  // Prepared once and reused for every call.
  private readonly selectPlayer: StatementSync;
  private readonly renamePlayer: StatementSync;
  private readonly insertPlayer: StatementSync;
  private readonly addWin: StatementSync;
  private readonly addLoss: StatementSync;
  private readonly insertTicket: StatementSync;
  private readonly selectTicket: StatementSync;
  private readonly deleteTicket: StatementSync;
  private readonly deleteOldTickets: StatementSync;
  private readonly insertScore: StatementSync;
  private readonly selectScoreByRun: StatementSync;
  private readonly selectStanding: StatementSync;
  private readonly countInRange: StatementSync;
  private readonly topByScore: StatementSync;
  private readonly topByMult: StatementSync;
  private readonly selectReplay: StatementSync;
  private readonly updateHidden: StatementSync;
  private readonly selectRecent: StatementSync;

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
    this.migrate();

    this.selectPlayer = this.db.prepare(
      'SELECT token, name, wins, losses FROM players WHERE token = ?',
    );
    this.renamePlayer = this.db.prepare('UPDATE players SET name = ? WHERE token = ?');
    this.insertPlayer = this.db.prepare('INSERT INTO players (token, name) VALUES (?, ?)');
    this.addWin = this.db.prepare('UPDATE players SET wins = wins + 1 WHERE token = ?');
    this.addLoss = this.db.prepare('UPDATE players SET losses = losses + 1 WHERE token = ?');

    this.insertTicket = this.db.prepare(
      'INSERT INTO solo_tickets (run_id, seed, sim_version, issued_at) VALUES (?, ?, ?, ?)',
    );
    this.selectTicket = this.db.prepare(
      'SELECT run_id, seed, sim_version, issued_at FROM solo_tickets WHERE run_id = ?',
    );
    this.deleteTicket = this.db.prepare('DELETE FROM solo_tickets WHERE run_id = ?');
    this.deleteOldTickets = this.db.prepare('DELETE FROM solo_tickets WHERE issued_at < ?');
    this.insertScore = this.db.prepare(
      `INSERT INTO solo_scores
         (run_id, name, score, top_multiplier, ticks, sim_version, created_at, replay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectScoreByRun = this.db.prepare(
      `SELECT ${SCORE_COLUMNS} FROM solo_scores WHERE run_id = ?`,
    );
    this.selectStanding = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM solo_scores s WHERE ${inRange('s')}
            AND (s.score > t.score OR (s.score = t.score AND s.id < t.id))) + 1 AS rank,
         (SELECT COUNT(*) FROM solo_scores s WHERE ${inRange('s')}) AS total
       FROM solo_scores t
       WHERE t.id = :id AND ${inRange('t')}`,
    );
    this.countInRange = this.db.prepare(
      `SELECT COUNT(*) AS n FROM solo_scores s WHERE ${inRange('s')}`,
    );
    this.topByScore = this.db.prepare(
      `SELECT ${SCORE_COLUMNS} FROM solo_scores s WHERE ${inRange('s')}
       ORDER BY score DESC, id LIMIT :limit`,
    );
    this.topByMult = this.db.prepare(
      `SELECT ${SCORE_COLUMNS} FROM solo_scores s WHERE ${inRange('s')}
       ORDER BY top_multiplier DESC, score DESC, id LIMIT :limit`,
    );
    this.selectReplay = this.db.prepare(
      `SELECT ${SCORE_COLUMNS}, replay FROM solo_scores WHERE id = ? AND hidden = 0`,
    );
    this.updateHidden = this.db.prepare('UPDATE solo_scores SET hidden = ? WHERE id = ?');
    this.selectRecent = this.db.prepare(
      `SELECT ${SCORE_COLUMNS} FROM solo_scores ORDER BY id DESC LIMIT ?`,
    );
  }

  /** Bring an older database up to {@link SCHEMA_VERSION}, one step per transaction. */
  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** Run `body` in a transaction, rolling back if it throws. */
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
    // Atomic: a failure part-way (a disk error, say) can't leave the win
    // recorded without the loss. A token with no row just updates nothing —
    // tolerated, as the store conformance suite expects.
    this.transaction(() => {
      this.addWin.run(winnerToken);
      this.addLoss.run(loserToken);
    });
    return Promise.resolve();
  }

  addTicket(ticket: SoloTicket): Promise<void> {
    this.insertTicket.run(ticket.runId, ticket.seed, ticket.simVersion, ticket.issuedAt);
    return Promise.resolve();
  }

  getTicket(runId: string): Promise<SoloTicket | null> {
    const row = this.selectTicket.get(runId) as TicketRow | undefined;
    return Promise.resolve(
      row
        ? {
            runId: row.run_id,
            seed: row.seed,
            simVersion: row.sim_version,
            issuedAt: row.issued_at,
          }
        : null,
    );
  }

  dropTicket(runId: string): Promise<void> {
    this.deleteTicket.run(runId);
    return Promise.resolve();
  }

  pruneTickets(before: number): Promise<number> {
    return Promise.resolve(Number(this.deleteOldTickets.run(before).changes));
  }

  recordRun(run: NewSoloScore): Promise<number | null> {
    const id = this.transaction(() => {
      if (Number(this.deleteTicket.run(run.runId).changes) === 0) return null;
      const { lastInsertRowid } = this.insertScore.run(
        run.runId,
        run.name,
        run.score,
        run.topMultiplier,
        run.ticks,
        run.simVersion,
        run.createdAt,
        run.replay,
      );
      return Number(lastInsertRowid);
    });
    return Promise.resolve(id);
  }

  scoreByRun(runId: string): Promise<StoredSoloScore | null> {
    const row = this.selectScoreByRun.get(runId) as ScoreRow | undefined;
    return Promise.resolve(row ? scoreOf(row) : null);
  }

  standing(id: number, range: TimeRange): Promise<SoloStanding | null> {
    const row = this.selectStanding.get({ id, ...range }) as SoloStanding | undefined;
    return Promise.resolve(row ? { rank: row.rank, total: row.total } : null);
  }

  countScores(range: TimeRange): Promise<number> {
    return Promise.resolve((this.countInRange.get({ ...range }) as { n: number }).n);
  }

  topScores(board: ScoreBoard, range: TimeRange, limit: number): Promise<StoredSoloScore[]> {
    const stmt = board === 'score' ? this.topByScore : this.topByMult;
    const rows = stmt.all({ ...range, limit }) as unknown as ScoreRow[];
    return Promise.resolve(rows.map(scoreOf));
  }

  getReplay(id: number): Promise<{ score: StoredSoloScore; replay: string } | null> {
    const row = this.selectReplay.get(id) as (ScoreRow & { replay: string }) | undefined;
    return Promise.resolve(row ? { score: scoreOf(row), replay: row.replay } : null);
  }

  setHidden(id: number, hidden: boolean): Promise<boolean> {
    return Promise.resolve(Number(this.updateHidden.run(hidden ? 1 : 0, id).changes) > 0);
  }

  recentScores(limit: number): Promise<StoredSoloScore[]> {
    const rows = this.selectRecent.all(limit) as unknown as ScoreRow[];
    return Promise.resolve(rows.map(scoreOf));
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

function scoreOf(row: ScoreRow): StoredSoloScore {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    score: row.score,
    topMultiplier: row.top_multiplier,
    ticks: row.ticks,
    simVersion: row.sim_version,
    createdAt: row.created_at,
    hidden: row.hidden !== 0,
  };
}

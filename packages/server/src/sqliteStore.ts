/**
 * sqliteStore.ts — SQLite-backed {@link LobbyStore}, {@link ScoreStore} and
 * {@link AccountStore}, on
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
import type { RatedGameEnd } from '@crack-attack/protocol';
import {
  START_RATING,
  accountIdOf,
  type AccountStore,
  type NewAccount,
  type NewRatedGame,
  type StoredAccount,
  type StoredRatedGame,
} from './accountStore.js';
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

interface AccountRow {
  id: number;
  handle: string;
  handle_folded: string;
  rating: number;
  rd: number;
  volatility: number;
  rated_at: number | null;
  wins: number;
  losses: number;
  draws: number;
  created_at: number;
  renamed_at: number | null;
  hidden: number;
}

interface RatedGameRow {
  id: number;
  account_a: number;
  account_b: number;
  handle_a: string | null;
  handle_b: string | null;
  result: 'a' | 'b' | 'draw';
  end_reason: RatedGameEnd;
  ticks: number;
  a_rating_before: number;
  a_rd_before: number;
  a_rating_after: number;
  a_rd_after: number;
  b_rating_before: number;
  b_rd_before: number;
  b_rating_after: number;
  b_rd_after: number;
  created_at: number;
}

/**
 * Schema upgrades, in order: entry `i` takes a database from `user_version` i
 * to i + 1. Version 0 is the original schema (just `players`, created above
 * them), so a database from before migrations existed upgrades like a new one.
 * Append only — never edit an entry that has shipped.
 */
export const MIGRATIONS: readonly string[] = [
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
    -- NULL once dropped: kept only for runs on a board (see SoloScoreboard).
    replay         TEXT,
    -- 1 once a sweep has kept or dropped the replay for good.
    replay_settled INTEGER NOT NULL DEFAULT 0,
    hidden         INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  -- Covering indexes, so the boards, counts and standings read only the
  -- index, never the table rows (where hidden sits behind the big replay).
  CREATE INDEX solo_scores_board_score ON solo_scores (hidden, score DESC, id, created_at);
  CREATE INDEX solo_scores_board_mult
    ON solo_scores (hidden, top_multiplier DESC, score DESC, id, created_at);
  CREATE INDEX solo_scores_visible_time ON solo_scores (hidden, created_at);
  -- Runs whose replay no sweep has settled. Partial, so a settled run (kept
  -- or dropped) leaves it and each sweep reads only runs it hasn't judged.
  CREATE INDEX solo_scores_replay_pending ON solo_scores (created_at)
    WHERE replay_settled = 0 AND hidden = 0;
  `,
  // 2: accounts and their sessions. Keys and session tokens are stored only
  // as SHA-256 hashes (hex). Ratings start at START_RATING (accountStore.ts),
  // written out here since a shipped migration never changes.
  `
  CREATE TABLE accounts (
    -- AUTOINCREMENT: a deleted account's id is never handed out again, so
    -- nothing keyed by it (rated games, the relay's record keys) can pass to
    -- a newer account.
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    handle        TEXT NOT NULL,
    handle_folded TEXT NOT NULL UNIQUE,
    key_hash      TEXT NOT NULL UNIQUE,
    rating        REAL NOT NULL DEFAULT 1500,
    rd            REAL NOT NULL DEFAULT 350,
    volatility    REAL NOT NULL DEFAULT 0.06,
    rated_at      INTEGER,
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    draws         INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    renamed_at    INTEGER,
    hidden        INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    account_id   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_account ON sessions (account_id);
  CREATE INDEX sessions_last_used ON sessions (last_used_at);
  `,
  // 3: the rated-game log, and the leaderboard's index. A game keeps both
  // accounts' ratings before and after it, so the ladder can be recomputed
  // from the log if the rating constants change.
  `
  CREATE TABLE rated_games (
    id              INTEGER PRIMARY KEY,
    account_a       INTEGER NOT NULL,
    account_b       INTEGER NOT NULL,
    result          TEXT NOT NULL CHECK (result IN ('a', 'b', 'draw')),
    end_reason      TEXT NOT NULL,
    ticks           INTEGER NOT NULL,
    seed            INTEGER NOT NULL,
    sim_version     INTEGER NOT NULL,
    a_rating_before REAL NOT NULL,
    a_rd_before     REAL NOT NULL,
    a_rating_after  REAL NOT NULL,
    a_rd_after      REAL NOT NULL,
    b_rating_before REAL NOT NULL,
    b_rd_before     REAL NOT NULL,
    b_rating_after  REAL NOT NULL,
    b_rd_after      REAL NOT NULL,
    created_at      INTEGER NOT NULL,
    -- Both seats' inputs (JSON); NULL once dropped.
    inputs          TEXT
  ) STRICT;
  CREATE INDEX rated_games_a ON rated_games (account_a, created_at);
  CREATE INDEX rated_games_b ON rated_games (account_b, created_at);
  CREATE INDEX rated_games_with_inputs ON rated_games (created_at) WHERE inputs IS NOT NULL;
  CREATE INDEX accounts_leaderboard ON accounts (hidden, rating DESC, id);
  `,
];

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.length;

const ACCOUNT_COLUMNS =
  'id, handle, handle_folded, rating, rd, volatility, rated_at, wins, losses, draws, ' +
  'created_at, renamed_at, hidden';

const RATED_GAME_COLUMNS =
  'g.id, g.account_a, g.account_b, ha.handle AS handle_a, hb.handle AS handle_b, g.result, ' +
  'g.end_reason, g.ticks, g.a_rating_before, g.a_rd_before, g.a_rating_after, g.a_rd_after, ' +
  'g.b_rating_before, g.b_rd_before, g.b_rating_after, g.b_rd_after, g.created_at';

const SCORE_COLUMNS =
  'id, run_id, name, score, top_multiplier, ticks, sim_version, created_at, hidden';
/** A board lists visible runs only, so `hidden` needn't be read from the row. */
const BOARD_COLUMNS = 'id, run_id, name, score, top_multiplier, ticks, sim_version, created_at';
/** SQL condition: the run in table `t` is visible and created in `[:from, :to)`. */
const inRange = (t: string): string =>
  `${t}.hidden = 0 AND ${t}.created_at >= :from AND ${t}.created_at < :to`;
/**
 * {@link inRange} for a query that walks a board index: `+created_at` still
 * filters on the index's own column, but keeps the planner from picking the
 * time index for the range and then sorting every run in it.
 */
const inRangeOnBoard = (t: string): string =>
  `${t}.hidden = 0 AND +${t}.created_at >= :from AND +${t}.created_at < :to`;

/**
 * The board, count and standing queries. Exported so a test can check they
 * stay index-only (EXPLAIN QUERY PLAN).
 */
export const SCORE_QUERIES = {
  count: `SELECT COUNT(*) AS n FROM solo_scores s WHERE ${inRange('s')}`,
  topByScore: `SELECT ${BOARD_COLUMNS}, 0 AS hidden FROM solo_scores s
    WHERE ${inRangeOnBoard('s')} ORDER BY score DESC, id LIMIT :limit`,
  topByMult: `SELECT ${BOARD_COLUMNS}, 0 AS hidden FROM solo_scores s
    WHERE ${inRangeOnBoard('s')} ORDER BY top_multiplier DESC, score DESC, id LIMIT :limit`,
  // Rank as two index range counts (higher score; same score, earlier run):
  // an OR of the two would defeat the index seek.
  standing: `SELECT
      (SELECT COUNT(*) FROM solo_scores s WHERE ${inRangeOnBoard('s')} AND s.score > t.score)
      + (SELECT COUNT(*) FROM solo_scores s
           WHERE ${inRangeOnBoard('s')} AND s.score = t.score AND s.id < t.id)
      + 1 AS rank,
      (SELECT COUNT(*) FROM solo_scores s WHERE ${inRange('s')}) AS total
    FROM solo_scores t
    WHERE t.id = :id AND ${inRange('t')}`,
  // Pinned: a planner without statistics picks the time index, which also
  // walks every run whose replay is already settled.
  replayCandidates: `SELECT ${SCORE_COLUMNS} FROM solo_scores s INDEXED BY solo_scores_replay_pending
    WHERE s.replay_settled = 0 AND s.hidden = 0 AND s.created_at < :before
    ORDER BY s.created_at LIMIT :limit`,
} as const;

export class SqliteStore implements LobbyStore, ScoreStore, AccountStore {
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
  private readonly selectVisibleScore: StatementSync;
  private readonly selectReplayCandidates: StatementSync;
  private readonly keepReplay: StatementSync;
  private readonly dropReplay: StatementSync;
  private readonly updateHidden: StatementSync;
  private readonly selectRecent: StatementSync;
  private readonly takeGuest: StatementSync;
  private readonly insertAccount: StatementSync;
  private readonly selectAccount: StatementSync;
  private readonly selectAccountByKey: StatementSync;
  private readonly selectAccountByHandle: StatementSync;
  private readonly insertSession: StatementSync;
  private readonly selectSession: StatementSync;
  private readonly touchSession: StatementSync;
  private readonly deleteSession: StatementSync;
  private readonly deleteOldSessions: StatementSync;
  private readonly deleteOtherSessions: StatementSync;
  private readonly deleteAccountSessions: StatementSync;
  private readonly updateKey: StatementSync;
  private readonly updateHandle: StatementSync;
  private readonly deleteAccountRow: StatementSync;
  private readonly updateAccountHidden: StatementSync;
  private readonly updateResetRating: StatementSync;
  private readonly addAccountWin: StatementSync;
  private readonly addAccountLoss: StatementSync;
  private readonly insertRatedGame: StatementSync;
  private readonly applyRatedGame: StatementSync;
  private readonly countPairGames: StatementSync;
  private readonly selectLeaderboard: StatementSync;
  private readonly selectRatedGames: StatementSync;
  private readonly dropOldGameInputs: StatementSync;

  /** @param path Database file path, or ':memory:' for an ephemeral store. */
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL lets readers (a backup, say) run alongside the relay's writes; on a
    // lock, wait briefly instead of failing straight away with SQLITE_BUSY.
    // (The timeout first, so switching to WAL waits out a lock too.)
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
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
    this.selectStanding = this.db.prepare(SCORE_QUERIES.standing);
    this.countInRange = this.db.prepare(SCORE_QUERIES.count);
    this.topByScore = this.db.prepare(SCORE_QUERIES.topByScore);
    this.topByMult = this.db.prepare(SCORE_QUERIES.topByMult);
    this.selectReplay = this.db.prepare(
      `SELECT ${SCORE_COLUMNS}, replay FROM solo_scores
       WHERE id = ? AND hidden = 0 AND replay IS NOT NULL`,
    );
    this.selectVisibleScore = this.db.prepare(
      `SELECT ${SCORE_COLUMNS} FROM solo_scores WHERE id = ? AND hidden = 0`,
    );
    this.selectReplayCandidates = this.db.prepare(SCORE_QUERIES.replayCandidates);
    // `hidden = 0`: a run the admin CLI hid since the sweep read it is left alone.
    this.keepReplay = this.db.prepare(
      'UPDATE solo_scores SET replay_settled = 1 WHERE id = ? AND hidden = 0',
    );
    this.dropReplay = this.db.prepare(
      'UPDATE solo_scores SET replay_settled = 1, replay = NULL WHERE id = ? AND hidden = 0',
    );
    this.updateHidden = this.db.prepare('UPDATE solo_scores SET hidden = ? WHERE id = ?');
    this.selectRecent = this.db.prepare(
      `SELECT ${SCORE_COLUMNS} FROM solo_scores ORDER BY id DESC LIMIT ?`,
    );

    this.takeGuest = this.db.prepare('DELETE FROM players WHERE token = ? RETURNING wins, losses');
    this.insertAccount = this.db.prepare(
      `INSERT INTO accounts (handle, handle_folded, key_hash, wins, losses, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.selectAccount = this.db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`);
    this.selectAccountByKey = this.db.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE key_hash = ?`,
    );
    this.selectAccountByHandle = this.db.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE handle_folded = ?`,
    );
    this.insertSession = this.db.prepare(
      'INSERT INTO sessions (token_hash, account_id, last_used_at) VALUES (?, ?, ?)',
    );
    this.selectSession = this.db.prepare(
      'SELECT account_id, last_used_at FROM sessions WHERE token_hash = ?',
    );
    this.touchSession = this.db.prepare(
      'UPDATE sessions SET last_used_at = ? WHERE token_hash = ?',
    );
    this.deleteSession = this.db.prepare('DELETE FROM sessions WHERE token_hash = ?');
    this.deleteOldSessions = this.db.prepare('DELETE FROM sessions WHERE last_used_at < ?');
    this.deleteOtherSessions = this.db.prepare(
      'DELETE FROM sessions WHERE account_id = ? AND token_hash != ?',
    );
    this.deleteAccountSessions = this.db.prepare('DELETE FROM sessions WHERE account_id = ?');
    this.updateKey = this.db.prepare('UPDATE accounts SET key_hash = ? WHERE id = ?');
    this.updateHandle = this.db.prepare(
      `UPDATE accounts SET handle = ?, handle_folded = ?, renamed_at = coalesce(?, renamed_at)
       WHERE id = ?`,
    );
    this.deleteAccountRow = this.db.prepare('DELETE FROM accounts WHERE id = ?');
    this.updateAccountHidden = this.db.prepare('UPDATE accounts SET hidden = ? WHERE id = ?');
    this.updateResetRating = this.db.prepare(
      'UPDATE accounts SET rating = ?, rd = ?, volatility = ?, rated_at = NULL WHERE id = ?',
    );
    this.addAccountWin = this.db.prepare('UPDATE accounts SET wins = wins + 1 WHERE id = ?');
    this.addAccountLoss = this.db.prepare('UPDATE accounts SET losses = losses + 1 WHERE id = ?');
    this.insertRatedGame = this.db.prepare(
      `INSERT INTO rated_games (account_a, account_b, result, end_reason, ticks, seed, sim_version,
         a_rating_before, a_rd_before, a_rating_after, a_rd_after,
         b_rating_before, b_rd_before, b_rating_after, b_rd_after, created_at, inputs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.applyRatedGame = this.db.prepare(
      `UPDATE accounts SET rating = :rating, rd = :rd, volatility = :volatility, rated_at = :at,
         wins = wins + :win, losses = losses + :loss, draws = draws + :draw
       WHERE id = :id`,
    );
    // Two index range counts, one per seat order: an OR would defeat the indexes.
    this.countPairGames = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM rated_games
            WHERE account_a = :a AND account_b = :b AND created_at >= :since)
         + (SELECT COUNT(*) FROM rated_games
            WHERE account_a = :b AND account_b = :a AND created_at >= :since) AS n`,
    );
    this.selectLeaderboard = this.db.prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts
       WHERE hidden = 0 AND rd <= :maxRd AND rated_at >= :since
       ORDER BY rating DESC, id LIMIT :limit`,
    );
    this.selectRatedGames = this.db.prepare(
      `SELECT ${RATED_GAME_COLUMNS} FROM (
         SELECT * FROM (SELECT * FROM rated_games WHERE account_a = :id
                        ORDER BY created_at DESC, id DESC LIMIT :limit)
         UNION ALL
         SELECT * FROM (SELECT * FROM rated_games WHERE account_b = :id
                        ORDER BY created_at DESC, id DESC LIMIT :limit)
       ) g
       LEFT JOIN accounts ha ON ha.id = g.account_a
       LEFT JOIN accounts hb ON hb.id = g.account_b
       ORDER BY g.created_at DESC, g.id DESC LIMIT :limit`,
    );
    this.dropOldGameInputs = this.db.prepare(
      'UPDATE rated_games SET inputs = NULL WHERE inputs IS NOT NULL AND created_at < ?',
    );
  }

  /**
   * Bring an older database up to {@link SCHEMA_VERSION}, one step per
   * transaction. Another process (the admin CLI beside the relay, say) may be
   * migrating the same file at once, so each step re-reads the version under
   * the write lock and skips a step the other already made.
   */
  private migrate(): void {
    while (this.userVersion() < MIGRATIONS.length) {
      this.transaction(() => {
        const v = this.userVersion();
        if (v >= MIGRATIONS.length) return;
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private userVersion(): number {
    return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  /**
   * Run `body` in a transaction, rolling back if it throws. IMMEDIATE takes
   * the write lock up front (every transaction here writes), so reads inside
   * it are current and a competing writer waits out the busy timeout.
   */
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
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

  recordResult(winnerKey: string, loserKey: string): Promise<void> {
    // Atomic: a failure part-way (a disk error, say) can't leave the win
    // recorded without the loss. A key with no row just updates nothing —
    // tolerated, as the store conformance suite expects.
    this.transaction(() => {
      const winner = accountIdOf(winnerKey);
      const loser = accountIdOf(loserKey);
      if (winner === null) this.addWin.run(winnerKey);
      else this.addAccountWin.run(winner);
      if (loser === null) this.addLoss.run(loserKey);
      else this.addAccountLoss.run(loser);
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

  visibleScore(id: number): Promise<StoredSoloScore | null> {
    const row = this.selectVisibleScore.get(id) as ScoreRow | undefined;
    return Promise.resolve(row ? scoreOf(row) : null);
  }

  replayCandidates(before: number, limit: number): Promise<StoredSoloScore[]> {
    const rows = this.selectReplayCandidates.all({ before, limit }) as unknown as ScoreRow[];
    return Promise.resolve(rows.map(scoreOf));
  }

  settleReplays(keep: readonly number[], drop: readonly number[]): Promise<void> {
    this.transaction(() => {
      for (const id of keep) this.keepReplay.run(id);
      for (const id of drop) this.dropReplay.run(id);
    });
    return Promise.resolve();
  }

  setHidden(id: number, hidden: boolean): Promise<boolean> {
    return Promise.resolve(Number(this.updateHidden.run(hidden ? 1 : 0, id).changes) > 0);
  }

  recentScores(limit: number): Promise<StoredSoloScore[]> {
    const rows = this.selectRecent.all(limit) as unknown as ScoreRow[];
    return Promise.resolve(rows.map(scoreOf));
  }

  createAccount(account: NewAccount): Promise<StoredAccount | null> {
    const created = this.transaction(() => {
      // Under the write lock, so no other writer can take the handle between
      // this check and the insert.
      if (this.selectAccountByHandle.get(account.handleFolded)) return null;
      const guest =
        account.guestToken === undefined
          ? undefined
          : (this.takeGuest.get(account.guestToken) as
              { wins: number; losses: number } | undefined);
      const { lastInsertRowid } = this.insertAccount.run(
        account.handle,
        account.handleFolded,
        account.keyHash,
        guest?.wins ?? 0,
        guest?.losses ?? 0,
        account.createdAt,
      );
      const id = Number(lastInsertRowid);
      this.insertSession.run(account.sessionHash, id, account.createdAt);
      return this.selectAccount.get(id) as unknown as AccountRow;
    });
    return Promise.resolve(created ? accountOf(created) : null);
  }

  accountByKey(keyHash: string): Promise<StoredAccount | null> {
    const row = this.selectAccountByKey.get(keyHash) as AccountRow | undefined;
    return Promise.resolve(row ? accountOf(row) : null);
  }

  accountByHandle(handleFolded: string): Promise<StoredAccount | null> {
    const row = this.selectAccountByHandle.get(handleFolded) as AccountRow | undefined;
    return Promise.resolve(row ? accountOf(row) : null);
  }

  addSession(sessionHash: string, accountId: number, now: number): Promise<void> {
    this.insertSession.run(sessionHash, accountId, now);
    return Promise.resolve();
  }

  useSession(sessionHash: string, now: number, staleBefore: number): Promise<StoredAccount | null> {
    const session = this.selectSession.get(sessionHash) as
      { account_id: number; last_used_at: number } | undefined;
    if (!session) return Promise.resolve(null);
    if (session.last_used_at < staleBefore) {
      this.deleteSession.run(sessionHash);
      return Promise.resolve(null);
    }
    const row = this.selectAccount.get(session.account_id) as AccountRow | undefined;
    if (!row) return Promise.resolve(null);
    this.touchSession.run(now, sessionHash);
    return Promise.resolve(accountOf(row));
  }

  endSession(sessionHash: string): Promise<void> {
    this.deleteSession.run(sessionHash);
    return Promise.resolve();
  }

  pruneSessions(before: number): Promise<number> {
    return Promise.resolve(Number(this.deleteOldSessions.run(before).changes));
  }

  replaceKey(accountId: number, keyHash: string, keepSessionHash: string): Promise<void> {
    this.transaction(() => {
      this.updateKey.run(keyHash, accountId);
      this.deleteOtherSessions.run(accountId, keepSessionHash);
    });
    return Promise.resolve();
  }

  renameAccount(
    accountId: number,
    handle: string,
    handleFolded: string,
    renamedAt: number | null,
  ): Promise<StoredAccount | null> {
    const renamed = this.transaction(() => {
      const holder = this.selectAccountByHandle.get(handleFolded) as AccountRow | undefined;
      if (holder && holder.id !== accountId) return null;
      if (Number(this.updateHandle.run(handle, handleFolded, renamedAt, accountId).changes) === 0) {
        return null;
      }
      return this.selectAccount.get(accountId) as unknown as AccountRow;
    });
    return Promise.resolve(renamed ? accountOf(renamed) : null);
  }

  deleteAccount(accountId: number): Promise<boolean> {
    const deleted = this.transaction(() => {
      this.deleteAccountSessions.run(accountId);
      return Number(this.deleteAccountRow.run(accountId).changes) > 0;
    });
    return Promise.resolve(deleted);
  }

  setAccountHidden(accountId: number, hidden: boolean): Promise<boolean> {
    const { changes } = this.updateAccountHidden.run(hidden ? 1 : 0, accountId);
    return Promise.resolve(Number(changes) > 0);
  }

  accountById(accountId: number): Promise<StoredAccount | null> {
    const row = this.selectAccount.get(accountId) as AccountRow | undefined;
    return Promise.resolve(row ? accountOf(row) : null);
  }

  recordRatedGame(game: NewRatedGame): Promise<number> {
    const id = this.transaction(() => {
      const { lastInsertRowid } = this.insertRatedGame.run(
        game.accountA,
        game.accountB,
        game.result,
        game.end,
        game.ticks,
        game.seed,
        game.simVersion,
        game.aBefore.rating,
        game.aBefore.rd,
        game.aAfter.rating,
        game.aAfter.rd,
        game.bBefore.rating,
        game.bBefore.rd,
        game.bAfter.rating,
        game.bAfter.rd,
        game.createdAt,
        game.inputs,
      );
      const scoreA = game.result === 'a' ? 1 : game.result === 'b' ? 0 : 0.5;
      for (const [accountId, after, score] of [
        [game.accountA, game.aAfter, scoreA],
        [game.accountB, game.bAfter, 1 - scoreA],
      ] as const) {
        this.applyRatedGame.run({
          id: accountId,
          rating: after.rating,
          rd: after.rd,
          volatility: after.volatility,
          at: game.createdAt,
          win: score === 1 ? 1 : 0,
          loss: score === 0 ? 1 : 0,
          draw: score === 0.5 ? 1 : 0,
        });
      }
      return Number(lastInsertRowid);
    });
    return Promise.resolve(id);
  }

  countRatedGames(accountA: number, accountB: number, since: number): Promise<number> {
    const row = this.countPairGames.get({ a: accountA, b: accountB, since }) as { n: number };
    return Promise.resolve(row.n);
  }

  leaderboard(activeSince: number, maxRd: number, limit: number): Promise<StoredAccount[]> {
    const rows = this.selectLeaderboard.all({
      since: activeSince,
      maxRd,
      limit,
    }) as unknown as AccountRow[];
    return Promise.resolve(rows.map(accountOf));
  }

  ratedGames(accountId: number, limit: number): Promise<StoredRatedGame[]> {
    const rows = this.selectRatedGames.all({ id: accountId, limit }) as unknown as RatedGameRow[];
    return Promise.resolve(rows.map(ratedGameOf));
  }

  dropGameInputs(before: number): Promise<number> {
    return Promise.resolve(Number(this.dropOldGameInputs.run(before).changes));
  }

  resetRating(accountId: number): Promise<boolean> {
    const { rating, rd, volatility } = START_RATING;
    const { changes } = this.updateResetRating.run(rating, rd, volatility, accountId);
    return Promise.resolve(Number(changes) > 0);
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

function accountOf(row: AccountRow): StoredAccount {
  return {
    id: row.id,
    handle: row.handle,
    handleFolded: row.handle_folded,
    rating: row.rating,
    rd: row.rd,
    volatility: row.volatility,
    ratedAt: row.rated_at,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    createdAt: row.created_at,
    renamedAt: row.renamed_at,
    hidden: row.hidden !== 0,
  };
}

function ratedGameOf(row: RatedGameRow): StoredRatedGame {
  return {
    id: row.id,
    accountA: row.account_a,
    accountB: row.account_b,
    handleA: row.handle_a,
    handleB: row.handle_b,
    result: row.result,
    end: row.end_reason,
    ticks: row.ticks,
    aBefore: { rating: row.a_rating_before, rd: row.a_rd_before },
    aAfter: { rating: row.a_rating_after, rd: row.a_rd_after },
    bBefore: { rating: row.b_rating_before, rd: row.b_rd_before },
    bAfter: { rating: row.b_rating_after, rd: row.b_rd_after },
    createdAt: row.created_at,
  };
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

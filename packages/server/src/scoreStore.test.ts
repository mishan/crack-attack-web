/**
 * Conformance suite run against every ScoreStore implementation, so a future
 * backend drops in with the same board order and guarantees.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { ALL_TIME, MemoryScoreStore, type NewSoloScore, type ScoreStore } from './scoreStore.js';
import { MIGRATIONS, SCHEMA_VERSION, SCORE_QUERIES, SqliteStore } from './sqliteStore.js';

const T0 = Date.UTC(2026, 8, 13);
const rid = (n: number): string => n.toString(16).padStart(32, '0');

const run = (n: number, over: Partial<NewSoloScore> = {}): NewSoloScore => ({
  runId: rid(n),
  name: `p${n}`,
  score: 10,
  topMultiplier: 1,
  ticks: 500,
  simVersion: 1,
  createdAt: T0,
  replay: `{"n":${n}}`,
  ...over,
});

/** Ticket and record a run; returns its id. */
async function add(store: ScoreStore, r: NewSoloScore): Promise<number> {
  await store.addTicket({ runId: r.runId, seed: 7, simVersion: 1, issuedAt: T0 });
  const id = await store.recordRun(r);
  if (id === null) throw new Error('run not recorded');
  return id;
}

function conformance(name: string, make: () => ScoreStore): void {
  describe(name, () => {
    it('keeps tickets until used, dropped, or pruned', async () => {
      const store = make();
      const ticket = { runId: rid(1), seed: 7, simVersion: 1, issuedAt: T0 };
      await store.addTicket(ticket);
      await store.addTicket({ ...ticket, runId: rid(2), issuedAt: T0 + 10 });
      await store.addTicket({ ...ticket, runId: rid(3) });
      expect(await store.getTicket(rid(1))).toEqual(ticket);
      expect(await store.getTicket(rid(9))).toBeNull();
      await store.dropTicket(rid(3));
      expect(await store.getTicket(rid(3))).toBeNull();
      expect(await store.pruneTickets(T0 + 5)).toBe(1);
      expect(await store.getTicket(rid(1))).toBeNull();
      expect(await store.getTicket(rid(2))).not.toBeNull();
      await store.close();
    });

    it('refuses to issue a run id twice', async () => {
      const store = make();
      const ticket = { runId: rid(1), seed: 7, simVersion: 1, issuedAt: T0 };
      await store.addTicket(ticket);
      // Async wrapper: a backend may throw rather than reject.
      await expect((async () => store.addTicket({ ...ticket, seed: 8 }))()).rejects.toThrow();
      expect(await store.getTicket(rid(1))).toEqual(ticket);
      await store.close();
    });

    it('never records a run id twice, even on a re-added ticket', async () => {
      const store = make();
      await add(store, run(1));
      await store.addTicket({ runId: rid(1), seed: 7, simVersion: 1, issuedAt: T0 });
      await expect((async () => store.recordRun(run(1)))()).rejects.toThrow();
      expect(await store.getTicket(rid(1))).not.toBeNull(); // rolled back
      expect(await store.countScores(ALL_TIME)).toBe(1);
      await store.close();
    });

    it('lists no recent runs for a limit of 0', async () => {
      const store = make();
      await add(store, run(1));
      await add(store, run(2));
      expect(await store.recentScores(0)).toEqual([]);
      expect((await store.recentScores(1)).map((r) => r.runId)).toEqual([rid(2)]);
      await store.close();
    });

    it('records a run once, using up its ticket', async () => {
      const store = make();
      const id = await add(store, run(1));
      expect(await store.getTicket(rid(1))).toBeNull();
      expect(await store.recordRun(run(1))).toBeNull(); // ticket already used
      expect(await store.recordRun(run(2))).toBeNull(); // never ticketed
      expect(await store.scoreByRun(rid(1))).toEqual({
        id,
        runId: rid(1),
        name: 'p1',
        score: 10,
        topMultiplier: 1,
        ticks: 500,
        simVersion: 1,
        createdAt: T0,
        hidden: false,
      });
      expect(await store.scoreByRun(rid(2))).toBeNull();
      await store.close();
    });

    it('ranks in board order, earlier runs first on ties', async () => {
      const store = make();
      const a = await add(store, run(1, { score: 50, topMultiplier: 2 }));
      const b = await add(store, run(2, { score: 80, topMultiplier: 2 }));
      const c = await add(store, run(3, { score: 50, topMultiplier: 4 }));
      const d = await add(store, run(4, { score: 80, topMultiplier: 3 }));
      const ids = async (board: 'score' | 'mult', limit = 10) =>
        (await store.topScores(board, ALL_TIME, limit)).map((r) => r.id);
      expect(await ids('score')).toEqual([b, d, a, c]);
      expect(await ids('mult')).toEqual([c, d, b, a]);
      expect(await ids('score', 2)).toEqual([b, d]);
      expect(await store.standing(a, ALL_TIME)).toEqual({ rank: 3, total: 4 });
      expect(await store.standing(d, ALL_TIME)).toEqual({ rank: 2, total: 4 });
      expect(await store.standing(999, ALL_TIME)).toBeNull();
      await store.close();
    });

    it('filters by creation time and leaves hidden runs out', async () => {
      const store = make();
      const august = await add(store, run(1, { score: 90, createdAt: Date.UTC(2026, 7, 31, 23) }));
      const sep1 = await add(store, run(2, { score: 10, createdAt: Date.UTC(2026, 8, 1) }));
      const sep2 = await add(store, run(3, { score: 20, createdAt: Date.UTC(2026, 8, 2) }));
      const september = { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 9, 1) };

      expect(await store.countScores(ALL_TIME)).toBe(3);
      expect(await store.countScores(september)).toBe(2);
      expect((await store.topScores('score', september, 10)).map((r) => r.id)).toEqual([
        sep2,
        sep1,
      ]);
      expect(await store.standing(sep1, september)).toEqual({ rank: 2, total: 2 });
      expect(await store.standing(august, september)).toBeNull();

      expect(await store.setHidden(sep2, true)).toBe(true);
      expect(await store.setHidden(999, true)).toBe(false);
      expect(await store.countScores(september)).toBe(1);
      expect(await store.standing(sep1, september)).toEqual({ rank: 1, total: 1 });
      expect(await store.standing(sep2, ALL_TIME)).toBeNull();
      expect((await store.topScores('mult', ALL_TIME, 10)).map((r) => r.id)).not.toContain(sep2);
      expect(await store.getReplay(sep2)).toBeNull();
      const recent = await store.recentScores(10);
      expect(recent.map((r) => [r.id, r.hidden])).toEqual([
        [sep2, true],
        [sep1, false],
        [august, false],
      ]);
      expect((await store.recentScores(1)).map((r) => r.id)).toEqual([sep2]);

      await store.setHidden(sep2, false);
      expect(await store.countScores(september)).toBe(2);
      await store.close();
    });

    it('returns a visible run with its replay', async () => {
      const store = make();
      const id = await add(store, run(1));
      const found = await store.getReplay(id);
      expect(found?.replay).toBe('{"n":1}');
      expect(found?.score).toEqual(await store.scoreByRun(rid(1)));
      expect(await store.getReplay(999)).toBeNull();
      await store.close();
    });

    it('offers old visible unsettled replays, oldest first, and settles them', async () => {
      const store = make();
      const late = await add(store, run(1, { createdAt: T0 + 20 }));
      const early = await add(store, run(2, { createdAt: T0 + 10 }));
      const hidden = await add(store, run(3, { createdAt: T0 }));
      const kept = await add(store, run(4, { createdAt: T0 + 15 }));
      await add(store, run(5, { createdAt: T0 + 30 })); // too new
      await store.setHidden(hidden, true);
      const ids = async (limit = 10) =>
        (await store.replayCandidates(T0 + 30, limit)).map((r) => r.id);
      expect(await ids()).toEqual([early, kept, late]);
      expect(await ids(1)).toEqual([early]);

      await store.settleReplays([kept], [early]);
      expect(await store.getReplay(early)).toBeNull();
      expect((await store.getReplay(kept))?.replay).toBe('{"n":4}');
      // Settled either way, so no longer offered: a later sweep moves on.
      expect(await ids()).toEqual([late]);
      // A dropped replay's run stays on the boards.
      expect((await store.topScores('score', ALL_TIME, 10)).map((r) => r.id)).toContain(early);
      expect(await store.standing(early, ALL_TIME)).not.toBeNull();
      await store.close();
    });

    it('leaves a run hidden since it was offered as it is', async () => {
      const store = make();
      const id = await add(store, run(1));
      expect((await store.replayCandidates(T0 + 1, 10)).map((r) => r.id)).toEqual([id]);
      await store.setHidden(id, true); // the admin CLI, between a sweep's read and write
      await store.settleReplays([], [id]);
      await store.setHidden(id, false);
      expect((await store.getReplay(id))?.replay).toBe('{"n":1}');
      expect((await store.replayCandidates(T0 + 1, 10)).map((r) => r.id)).toEqual([id]);
      await store.close();
    });
  });
}

conformance('MemoryScoreStore', () => new MemoryScoreStore());
conformance('SqliteStore (:memory:)', () => new SqliteStore(':memory:'));

describe('SqliteStore migrations', () => {
  it('upgrades a database from before the scoreboard, keeping its players', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crack-attack-migrate-'));
    const path = join(dir, 'old.db');
    const token = '1'.repeat(32);
    try {
      // The schema as the relay wrote it before migrations existed.
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE players (
          token  TEXT PRIMARY KEY,
          name   TEXT NOT NULL,
          wins   INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        INSERT INTO players (token, name, wins) VALUES ('${token}', 'misha', 3);
      `);
      old.close();

      const store = new SqliteStore(path);
      expect((await store.getPlayer(token, 'misha'))?.record).toEqual({ wins: 3, losses: 0 });
      await add(store, run(1));
      await store.close();

      const check = new DatabaseSync(path);
      expect({ ...check.prepare('PRAGMA user_version').get() }).toEqual({
        user_version: SCHEMA_VERSION,
      });
      check.close();

      // Reopening an up-to-date database changes nothing.
      const again = new SqliteStore(path);
      expect(await again.countScores(ALL_TIME)).toBe(1);
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('waits out another process migrating the same file, then carries on from there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crack-attack-migrate-'));
    const path = join(dir, 'race.db');
    try {
      // "Another process" (a thread with its own connection): it takes the
      // write lock, makes step 1, and holds the lock a moment before committing.
      const holding = new Int32Array(new SharedArrayBuffer(4));
      const other = new Worker(
        `
        const { workerData: { path, holding, step1 } } = require('node:worker_threads');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(path);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('CREATE TABLE players (token TEXT PRIMARY KEY, name TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0) STRICT');
        db.exec('BEGIN IMMEDIATE');
        db.exec(step1);
        db.exec('PRAGMA user_version = 1');
        Atomics.store(holding, 0, 1);
        Atomics.notify(holding, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        db.exec('COMMIT');
        db.close();
        `,
        { eval: true, workerData: { path, holding, step1: MIGRATIONS[0] } },
      );
      const exited = new Promise((resolve, reject) => {
        other.on('exit', resolve);
        other.on('error', reject);
      });
      Atomics.wait(holding, 0, 0, 10_000);
      expect(Atomics.load(holding, 0)).toBe(1);

      // Reads version 0 (step 1 isn't committed yet), waits for the lock, then
      // must see version 1 and not make step 1 again ("table already exists").
      const store = new SqliteStore(path);
      await add(store, run(1));
      await store.close();
      expect(await exited).toBe(0);

      const check = new DatabaseSync(path);
      expect({ ...check.prepare('PRAGMA user_version').get() }).toEqual({
        user_version: SCHEMA_VERSION,
      });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteStore query plans', () => {
  /** EXPLAIN QUERY PLAN lines for each board query, on a freshly migrated database. */
  function plans(): Record<keyof typeof SCORE_QUERIES, string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'crack-attack-plan-'));
    const path = join(dir, 'plan.db');
    try {
      new SqliteStore(path).close();
      const db = new DatabaseSync(path);
      const range = { from: 0, to: 1 };
      const explain = (sql: string, params: Record<string, number>) =>
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(params)
          .map((row) => String(row['detail']));
      const result = {
        count: explain(SCORE_QUERIES.count, range),
        topByScore: explain(SCORE_QUERIES.topByScore, { ...range, limit: 10 }),
        topByMult: explain(SCORE_QUERIES.topByMult, { ...range, limit: 10 }),
        standing: explain(SCORE_QUERIES.standing, { ...range, id: 1 }),
        replayCandidates: explain(SCORE_QUERIES.replayCandidates, { before: 1, limit: 10 }),
      };
      db.close();
      return result;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('answers counts and standings from covering indexes alone', () => {
    const { count, standing } = plans();
    expect(count).toEqual([
      'SEARCH s USING COVERING INDEX solo_scores_visible_time (hidden=? AND created_at>? AND created_at<?)',
    ]);
    // The run itself by primary key; every count over the other runs index-only.
    expect(standing).toContain('SEARCH t USING INTEGER PRIMARY KEY (rowid=?)');
    const scans = standing.filter((line) => /^(SEARCH|SCAN) s /.test(line));
    expect(scans).toEqual([
      'SEARCH s USING COVERING INDEX solo_scores_board_score (hidden=? AND score>?)',
      'SEARCH s USING COVERING INDEX solo_scores_board_score (hidden=? AND score=? AND id<?)',
      'SEARCH s USING COVERING INDEX solo_scores_visible_time (hidden=? AND created_at>? AND created_at<?)',
    ]);
  });

  it('walks each board in its index order, with no sort', () => {
    const { topByScore, topByMult } = plans();
    expect(topByScore).toEqual(['SEARCH s USING INDEX solo_scores_board_score (hidden=?)']);
    expect(topByMult).toEqual(['SEARCH s USING INDEX solo_scores_board_mult (hidden=?)']);
  });

  it('finds replay candidates through the partial index, runs already settled left out', () => {
    const { replayCandidates } = plans();
    expect(replayCandidates).toHaveLength(1);
    expect(replayCandidates[0]).toMatch(/^SEARCH s USING INDEX solo_scores_replay_pending /);
  });
});

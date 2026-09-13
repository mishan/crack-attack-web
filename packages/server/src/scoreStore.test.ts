/**
 * Conformance suite run against every ScoreStore implementation, so a future
 * backend drops in with the same board order and guarantees.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ALL_TIME, MemoryScoreStore, type NewSoloScore, type ScoreStore } from './scoreStore.js';
import { SCHEMA_VERSION, SqliteStore } from './sqliteStore.js';

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
});

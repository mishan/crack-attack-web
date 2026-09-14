/**
 * scoreStore.ts — persistence for the solo scoreboard: outstanding run tickets
 * and verified runs (see docs/SCOREBOARD_PLAN.md). Abstract and async like
 * {@link LobbyStore}; `SqliteStore` implements both on one database file, and
 * {@link MemoryScoreStore} serves tests.
 *
 * Board order is part of the contract, so every backend ranks alike: the score
 * board sorts by score, the multiplier board by top multiplier then score, both
 * highest first, and ties go to the earlier run (the lower id).
 */

import type { ScoreBoard, SoloStanding } from '@crack-attack/protocol';

/** An issued, not yet used run ticket. */
export interface SoloTicket {
  runId: string;
  seed: number;
  simVersion: number;
  /** Epoch ms. */
  issuedAt: number;
}

/** A verified run, ready to store. */
export interface NewSoloScore {
  runId: string;
  name: string;
  score: number;
  topMultiplier: number;
  ticks: number;
  simVersion: number;
  /** Epoch ms. */
  createdAt: number;
  /** The replay, as JSON. */
  replay: string;
}

/** A stored run (without its replay). */
export interface StoredSoloScore extends Omit<NewSoloScore, 'replay'> {
  id: number;
  hidden: boolean;
}

/** A half-open window `[from, to)` of creation times, in epoch ms. */
export interface TimeRange {
  from: number;
  to: number;
}

export const ALL_TIME: TimeRange = { from: 0, to: Number.MAX_SAFE_INTEGER };

export interface ScoreStore {
  addTicket(ticket: SoloTicket): Promise<void>;
  /** A ticket by run id; null if unknown or used. */
  getTicket(runId: string): Promise<SoloTicket | null>;
  /** Delete a ticket without scoring it (a rejected run). */
  dropTicket(runId: string): Promise<void>;
  /** Delete tickets issued before `before`; returns how many. */
  pruneTickets(before: number): Promise<number>;
  /**
   * Atomically use the run's ticket and store the run. Returns its id, or null
   * if the ticket is gone (a concurrent duplicate submission got there first).
   */
  recordRun(run: NewSoloScore): Promise<number | null>;
  /** The run stored for a ticket, hidden or not; null if none. */
  scoreByRun(runId: string): Promise<StoredSoloScore | null>;
  /**
   * A visible run's place on the score board among visible runs created in
   * `range`; null if the run is unknown, hidden, or outside `range`.
   */
  standing(id: number, range: TimeRange): Promise<SoloStanding | null>;
  /** How many visible runs were created in `range`. */
  countScores(range: TimeRange): Promise<number>;
  /** The best `limit` visible runs created in `range`, in board order. */
  topScores(board: ScoreBoard, range: TimeRange, limit: number): Promise<StoredSoloScore[]>;
  /** A visible run and its replay JSON; null if unknown, hidden, or its replay was dropped. */
  getReplay(id: number): Promise<{ score: StoredSoloScore; replay: string } | null>;
  /**
   * Visible runs created before `before` whose replay isn't settled yet,
   * oldest first, at most `limit`: the candidates for {@link settleReplays}.
   */
  replayCandidates(before: number, limit: number): Promise<StoredSoloScore[]>;
  /**
   * Settle runs' replays for good: `keep` keep theirs, `drop` lose theirs
   * (the runs stay on the boards). Either way they're candidates no more. A
   * run hidden meanwhile is left as it is: the moderator's word wins.
   */
  settleReplays(keep: readonly number[], drop: readonly number[]): Promise<void>;
  /** Hide a run from the boards (or restore it); false if the id is unknown. */
  setHidden(id: number, hidden: boolean): Promise<boolean>;
  /** The newest `limit` runs, hidden ones included, newest first. */
  recentScores(limit: number): Promise<StoredSoloScore[]>;
  close(): Promise<void>;
}

/** Board order as a comparator (best first). */
export function compareScores(
  board: ScoreBoard,
): (a: StoredSoloScore, b: StoredSoloScore) => number {
  return board === 'score'
    ? (a, b) => b.score - a.score || a.id - b.id
    : (a, b) => b.topMultiplier - a.topMultiplier || b.score - a.score || a.id - b.id;
}

type Row = StoredSoloScore & { replay: string | null; replaySettled: boolean };

const publicCopy = ({ replay: _replay, replaySettled: _settled, ...score }: Row): StoredSoloScore =>
  score;

/**
 * In-memory score store, for tests: most queries scan every row. The relay
 * runs on `SqliteStore` (`DB=:memory:` included).
 */
export class MemoryScoreStore implements ScoreStore {
  private readonly tickets = new Map<string, SoloTicket>();
  private readonly rows: Row[] = [];

  addTicket(ticket: SoloTicket): Promise<void> {
    // As a primary key would: a run id is never issued twice.
    if (this.tickets.has(ticket.runId)) {
      return Promise.reject(new Error(`ticket ${ticket.runId} already exists`));
    }
    this.tickets.set(ticket.runId, { ...ticket });
    return Promise.resolve();
  }

  getTicket(runId: string): Promise<SoloTicket | null> {
    const ticket = this.tickets.get(runId);
    return Promise.resolve(ticket ? { ...ticket } : null);
  }

  dropTicket(runId: string): Promise<void> {
    this.tickets.delete(runId);
    return Promise.resolve();
  }

  pruneTickets(before: number): Promise<number> {
    let pruned = 0;
    for (const [runId, ticket] of this.tickets) {
      if (ticket.issuedAt < before) {
        this.tickets.delete(runId);
        pruned++;
      }
    }
    return Promise.resolve(pruned);
  }

  recordRun(run: NewSoloScore): Promise<number | null> {
    if (!this.tickets.has(run.runId)) return Promise.resolve(null);
    // As a unique column would; the ticket stays, as the transaction rolls back.
    if (this.rows.some((r) => r.runId === run.runId)) {
      return Promise.reject(new Error(`run ${run.runId} is already recorded`));
    }
    this.tickets.delete(run.runId);
    const id = this.rows.length + 1;
    this.rows.push({ ...run, id, hidden: false, replaySettled: false });
    return Promise.resolve(id);
  }

  scoreByRun(runId: string): Promise<StoredSoloScore | null> {
    const row = this.rows.find((r) => r.runId === runId);
    return Promise.resolve(row ? publicCopy(row) : null);
  }

  standing(id: number, range: TimeRange): Promise<SoloStanding | null> {
    const rows = this.visible(range);
    const me = rows.find((r) => r.id === id);
    if (!me) return Promise.resolve(null);
    const better = compareScores('score');
    const rank = rows.filter((r) => better(r, me) < 0).length + 1;
    return Promise.resolve({ rank, total: rows.length });
  }

  countScores(range: TimeRange): Promise<number> {
    return Promise.resolve(this.visible(range).length);
  }

  topScores(board: ScoreBoard, range: TimeRange, limit: number): Promise<StoredSoloScore[]> {
    const rows = this.visible(range).sort(compareScores(board)).slice(0, limit);
    return Promise.resolve(rows.map(publicCopy));
  }

  getReplay(id: number): Promise<{ score: StoredSoloScore; replay: string } | null> {
    const row = this.rows.find((r) => r.id === id && !r.hidden);
    return Promise.resolve(
      row && row.replay !== null ? { score: publicCopy(row), replay: row.replay } : null,
    );
  }

  replayCandidates(before: number, limit: number): Promise<StoredSoloScore[]> {
    const rows = this.rows
      .filter((r) => !r.hidden && !r.replaySettled && r.createdAt < before)
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
    return Promise.resolve(rows.slice(0, limit).map(publicCopy));
  }

  settleReplays(keep: readonly number[], drop: readonly number[]): Promise<void> {
    const kept = new Set(keep);
    const drops = new Set(drop);
    for (const row of this.rows) {
      if (row.hidden) continue;
      const dropped = drops.has(row.id);
      if (!dropped && !kept.has(row.id)) continue;
      row.replaySettled = true;
      if (dropped) row.replay = null;
    }
    return Promise.resolve();
  }

  setHidden(id: number, hidden: boolean): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.hidden = hidden;
    return Promise.resolve(row !== undefined);
  }

  recentScores(limit: number): Promise<StoredSoloScore[]> {
    // As SQL's LIMIT: 0 means none, a negative limit means no limit.
    const newest = this.rows.slice().reverse();
    return Promise.resolve((limit < 0 ? newest : newest.slice(0, limit)).map(publicCopy));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  private visible(range: TimeRange): Row[] {
    return this.rows.filter(
      (r) => !r.hidden && r.createdAt >= range.from && r.createdAt < range.to,
    );
  }
}

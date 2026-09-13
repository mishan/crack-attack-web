import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SIM_VERSION, type SoloReplay } from '@crack-attack/core';
import { SOLO_TICKET_TTL_MS } from '@crack-attack/protocol';
import { SoloScoreboard, type SoloScoreboardOptions } from './scoreboard.js';
import { ALL_TIME, MemoryScoreStore, type NewSoloScore, type ScoreStore } from './scoreStore.js';
import { SoloVerifier } from './soloVerifier.js';

/** A real solo game (hard AI, seed 2026): 2757 ticks, score 48, top multiplier 3. */
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../core/src/fixtures/solo-hard-2026.replay.json', import.meta.url)),
    'utf8',
  ),
) as SoloReplay;

/** Wall time the fixture takes to play at 50 ticks/s. */
const PLAY_MS = FIXTURE.ticks * 20;
/** 2026-09-13 12:00 UTC. */
const T0 = Date.UTC(2026, 8, 13, 12);
const CLIENT = '203.0.113.7';
const rid = (n: number): string => n.toString(16).padStart(32, '0');

function setup(options: Omit<SoloScoreboardOptions, 'store'> = {}) {
  const clock = { now: T0 };
  let runs = 0;
  const store = new MemoryScoreStore();
  const board = new SoloScoreboard({
    store,
    now: () => clock.now,
    newSeed: () => FIXTURE.seed,
    newRunId: () => rid(++runs),
    ...options,
  });
  return { store, board, clock };
}

/** Issue a ticket, then let a game's worth of time pass (plus the countdown). */
async function playRun(s: ReturnType<typeof setup>): Promise<string> {
  const { runId } = await s.board.issueTicket(CLIENT);
  s.clock.now += PLAY_MS + 3000;
  return runId;
}

const submission = (runId: string, over: Record<string, unknown> = {}) => ({
  runId,
  name: 'misha',
  replay: FIXTURE,
  ...over,
});

/** The fixture with its last tick cut off: a game still in play. */
function truncatedFixture(): SoloReplay {
  let tick = 0;
  const inputs = FIXTURE.inputs.filter(([delta]) => (tick += delta) < FIXTURE.ticks);
  return { ...FIXTURE, ticks: FIXTURE.ticks - 1, inputs };
}

describe('SoloScoreboard tickets', () => {
  it('issues single-use tickets for the current rules', async () => {
    const { board, store } = setup();
    const a = await board.issueTicket(CLIENT);
    const b = await board.issueTicket(CLIENT);
    expect(a).toEqual({
      runId: rid(1),
      seed: FIXTURE.seed,
      simVersion: SIM_VERSION,
      expiresAt: T0 + SOLO_TICKET_TTL_MS,
    });
    expect(b.runId).toBe(rid(2));
    expect(await store.getTicket(a.runId)).toEqual({
      runId: a.runId,
      seed: FIXTURE.seed,
      simVersion: SIM_VERSION,
      issuedAt: T0,
    });
  });

  it('sweeps expired tickets as it issues new ones', async () => {
    const { board, store } = setup();
    const stale = 'f'.repeat(32);
    await store.addTicket({
      runId: stale,
      seed: 1,
      simVersion: SIM_VERSION,
      issuedAt: T0 - SOLO_TICKET_TTL_MS - 1,
    });
    await board.issueTicket(CLIENT);
    expect(await store.getTicket(stale)).toBeNull();
  });

  it('rate-limits tickets per client', async () => {
    const { board, clock } = setup({ ticketLimit: { capacity: 2, refillMs: 1000 } });
    await board.issueTicket(CLIENT);
    await board.issueTicket(CLIENT);
    await expect(board.issueTicket(CLIENT)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
    await board.issueTicket('198.51.100.1'); // another client is unaffected
    clock.now += 1000;
    await board.issueTicket(CLIENT);
  });
});

describe('SoloScoreboard submissions', () => {
  it('re-simulates the run and ranks the score it computed', async () => {
    const s = setup();
    const runId = await playRun(s);
    // A claimed score is ignored: the server computes its own.
    const res = await s.board.submit(CLIENT, submission(runId, { score: 999_999 }));
    expect(res).toEqual({
      id: 1,
      name: 'misha',
      score: 48,
      topMultiplier: 3,
      ticks: FIXTURE.ticks,
      standing: { all: { rank: 1, total: 1 }, month: { rank: 1, total: 1 } },
    });
    expect(await s.store.getTicket(runId)).toBeNull();
  });

  it('cleans up the name', async () => {
    const s = setup();
    const runId = await playRun(s);
    const res = await s.board.submit(CLIENT, submission(runId, { name: '  Mi​sha  ' }));
    expect(res.name).toBe('Misha');
  });

  it('answers a repeat submission with the recorded result', async () => {
    const s = setup();
    const runId = await playRun(s);
    const first = await s.board.submit(CLIENT, submission(runId));
    expect(await s.board.submit(CLIENT, submission(runId, { name: 'other' }))).toEqual(first);
    expect(await s.store.countScores(ALL_TIME)).toBe(1);
  });

  it('rejects a run id it never issued', async () => {
    const s = setup();
    await expect(s.board.submit(CLIENT, submission(rid(99)))).rejects.toMatchObject({
      status: 409,
      code: 'unknown_run',
    });
  });

  it('rejects a run submitted sooner than it could be played, using up its ticket', async () => {
    const s = setup();
    const { runId } = await s.board.issueTicket(CLIENT);
    s.clock.now += PLAY_MS - 1;
    await expect(s.board.submit(CLIENT, submission(runId))).rejects.toMatchObject({
      status: 422,
      code: 'too_fast',
    });
    s.clock.now += 10_000;
    await expect(s.board.submit(CLIENT, submission(runId))).rejects.toMatchObject({
      code: 'unknown_run',
    });
  });

  it('rejects an expired ticket', async () => {
    const s = setup();
    const { runId } = await s.board.issueTicket(CLIENT);
    s.clock.now += SOLO_TICKET_TTL_MS + 1;
    await expect(s.board.submit(CLIENT, submission(runId))).rejects.toMatchObject({
      status: 409,
      code: 'expired_run',
    });
  });

  it('rejects a run begun under other rules', async () => {
    const s = setup();
    const runId = rid(50);
    await s.store.addTicket({
      runId,
      seed: FIXTURE.seed,
      simVersion: SIM_VERSION - 1,
      issuedAt: T0,
    });
    s.clock.now += PLAY_MS;
    await expect(s.board.submit(CLIENT, submission(runId))).rejects.toMatchObject({
      status: 409,
      code: 'stale_version',
    });
  });

  it('rejects a replay played on another seed', async () => {
    const s = setup({ newSeed: () => FIXTURE.seed + 1 });
    const runId = await playRun(s);
    await expect(s.board.submit(CLIENT, submission(runId))).rejects.toMatchObject({
      status: 422,
      code: 'invalid_replay',
    });
  });

  it('rejects a game that did not end, using up its ticket', async () => {
    const s = setup();
    const runId = await playRun(s);
    const res = s.board.submit(CLIENT, submission(runId, { replay: truncatedFixture() }));
    await expect(res).rejects.toMatchObject({ status: 422, code: 'invalid_replay' });
    await expect(res).rejects.toThrow(/still in play/);
    await expect(s.board.submit(CLIENT, submission(runId))).rejects.toMatchObject({
      code: 'unknown_run',
    });
  });

  it('rejects a malformed replay without touching the ticket', async () => {
    const s = setup();
    const runId = await playRun(s);
    await expect(
      s.board.submit(CLIENT, submission(runId, { replay: { ...FIXTURE, version: 99 } })),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_replay' });
    expect((await s.board.submit(CLIENT, submission(runId))).score).toBe(48);
  });

  it.each([
    ['a non-object', [1, 2], 'bad_request'],
    ['a missing run id', { name: 'x', replay: FIXTURE }, 'bad_request'],
    ['a malformed run id', { runId: 'nope', name: 'x', replay: FIXTURE }, 'bad_request'],
    ['a blank name', { runId: rid(1), name: ' ​ ', replay: FIXTURE }, 'bad_name'],
  ])('rejects %s', async (_label, body, code) => {
    const s = setup();
    await expect(s.board.submit(CLIENT, body)).rejects.toMatchObject({ status: 400, code });
  });

  it('reports busy, keeping the ticket, while the verifier queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = new SoloVerifier({ maxQueued: 1, sliceTicks: 100, yieldFn: () => gate });
    const s = setup({ verifier });
    const a = await s.board.issueTicket(CLIENT);
    const b = await s.board.issueTicket(CLIENT);
    s.clock.now += PLAY_MS;
    const first = s.board.submit(CLIENT, submission(a.runId));
    await vi.waitFor(() => expect(verifier.queued).toBe(1));
    await expect(s.board.submit(CLIENT, submission(b.runId))).rejects.toMatchObject({
      status: 503,
      code: 'busy',
    });
    release();
    await first;
    // Same score, later run: second place.
    const second = await s.board.submit(CLIENT, submission(b.runId));
    expect(second.standing.all).toEqual({ rank: 2, total: 2 });
  });

  it('rate-limits submissions per client', async () => {
    const s = setup({ submitLimit: { capacity: 1, refillMs: 60_000 } });
    await expect(s.board.submit(CLIENT, {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(s.board.submit(CLIENT, {})).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
  });
});

describe('SoloScoreboard boards', () => {
  /** Record a run straight into the store. */
  async function addRun(store: ScoreStore, n: number, over: Partial<NewSoloScore>) {
    await store.addTicket({ runId: rid(n), seed: 1, simVersion: SIM_VERSION, issuedAt: T0 });
    return store.recordRun({
      runId: rid(n),
      name: `p${n}`,
      score: 0,
      topMultiplier: 0,
      ticks: 100,
      simVersion: SIM_VERSION,
      createdAt: T0,
      replay: '{}',
      ...over,
    });
  }
  const query = (q: Record<string, string> = {}) => new URLSearchParams(q);

  it('ranks the score board by score and the multiplier board by multiplier, then score', async () => {
    const { board, store } = setup();
    await addRun(store, 1, { score: 50, topMultiplier: 2 });
    await addRun(store, 2, { score: 80, topMultiplier: 2 });
    await addRun(store, 3, { score: 50, topMultiplier: 4 });
    await addRun(store, 4, { score: 80, topMultiplier: 3 });

    const scores = await board.scores(query());
    expect(scores).toMatchObject({ board: 'score', period: 'all', month: null, total: 4 });
    expect(scores.entries.map((e) => [e.rank, e.id])).toEqual([
      [1, 2],
      [2, 4],
      [3, 1],
      [4, 3],
    ]);
    expect(scores.entries[0]).toEqual({
      rank: 1,
      id: 2,
      name: 'p2',
      score: 80,
      topMultiplier: 2,
      ticks: 100,
      createdAt: T0,
    });
    const mult = await board.scores(query({ board: 'mult' }));
    expect(mult.entries.map((e) => e.id)).toEqual([3, 4, 2, 1]);
  });

  it('serves this month, or any month asked for', async () => {
    const { board, store } = setup();
    await addRun(store, 1, { score: 90, createdAt: Date.UTC(2026, 7, 20) });
    await addRun(store, 2, { score: 10, createdAt: Date.UTC(2026, 8, 2) });

    const now = await board.scores(query({ period: 'month' }));
    expect(now).toMatchObject({ period: 'month', month: '2026-09', total: 1 });
    expect(now.entries.map((e) => e.id)).toEqual([2]);
    const august = await board.scores(query({ month: '2026-08' }));
    expect(august).toMatchObject({ period: 'month', month: '2026-08', total: 1 });
    expect(august.entries.map((e) => e.id)).toEqual([1]);
    expect((await board.scores(query())).total).toBe(2);
  });

  it("defaults to the original's table lengths and honours a limit", async () => {
    const { board, store } = setup();
    for (let n = 1; n <= 35; n++) await addRun(store, n, { score: n, topMultiplier: n });
    expect((await board.scores(query())).entries).toHaveLength(30);
    expect((await board.scores(query({ board: 'mult' }))).entries).toHaveLength(10);
    expect((await board.scores(query({ limit: '5' }))).entries).toHaveLength(5);
    expect((await board.scores(query())).total).toBe(35);
  });

  it('leaves hidden runs off the boards', async () => {
    const { board, store } = setup();
    const id = await addRun(store, 1, { score: 90 });
    await addRun(store, 2, { score: 10 });
    await store.setHidden(id!, true);
    const scores = await board.scores(query());
    expect(scores.total).toBe(1);
    expect(scores.entries.map((e) => e.id)).toEqual([2]);
  });

  it.each([
    [{ board: 'best' }],
    [{ period: 'week' }],
    [{ month: '2026-13' }],
    [{ period: 'all', month: '2026-09' }],
    [{ limit: '0' }],
    [{ limit: '101' }],
    [{ limit: 'ten' }],
  ])('rejects %j', async (q) => {
    const { board } = setup();
    await expect(board.scores(query(q))).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
  });

  it('serves a visible run with its replay', async () => {
    const s = setup();
    const runId = await playRun(s);
    const { id } = await s.board.submit(CLIENT, submission(runId));
    const res = await s.board.replay(String(id));
    expect(res.entry).toEqual({
      id,
      name: 'misha',
      score: 48,
      topMultiplier: 3,
      ticks: FIXTURE.ticks,
      createdAt: s.clock.now,
    });
    expect(res.replay).toEqual(FIXTURE);

    await s.store.setHidden(id, true);
    for (const idText of [String(id), '999', '0', 'abc', '1e3']) {
      await expect(s.board.replay(idText)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
    }
  });
});

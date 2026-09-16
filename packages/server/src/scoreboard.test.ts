import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CC_LEFT, CC_RIGHT, SIM_VERSION, type SoloReplay } from '@crack-attack/core';
import { SOLO_TICKET_TTL_MS, type SoloReplayResponse } from '@crack-attack/protocol';
import { clientKey } from './rateLimit.js';
import {
  DEFAULT_REPLAY_GRACE_MS,
  DEFAULT_SCORES_CACHE_MS,
  SoloScoreboard,
  type SoloScoreboardOptions,
} from './scoreboard.js';
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
    log: () => undefined,
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
      headers: { 'Retry-After': '1' }, // one ticket back per second here
    });
    await board.issueTicket('198.51.100.1'); // another client is unaffected
    clock.now += 1000;
    await board.issueTicket(CLIENT);
  });

  it('also limits tickets per IPv6 /48, however many /64s a client rotates through', async () => {
    const { board } = setup({ ticketSiteLimit: { capacity: 3, refillMs: 60_000 } });
    const in48 = (n: number) => clientKey(`2001:db8:1:${n.toString(16)}::1`);
    for (let n = 0; n < 3; n++) await board.issueTicket(in48(n));
    await expect(board.issueTicket(in48(0xbeef))).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      headers: { 'Retry-After': '60' },
    });
    await board.issueTicket(clientKey('2001:db8:2::1')); // another /48
    await board.issueTicket(CLIENT); // IPv4 has no /48 bucket
  });

  it('caps tickets across all clients', async () => {
    const { board, clock } = setup({ ticketGlobalLimit: { capacity: 3, refillMs: 500 } });
    for (let n = 1; n <= 3; n++) await board.issueTicket(`198.51.100.${n}`);
    await expect(board.issueTicket('198.51.100.4')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      headers: { 'Retry-After': '1' },
    });
    clock.now += 500;
    await board.issueTicket('198.51.100.4');
  });

  it("doesn't spend shared tickets on a client over its own limit", async () => {
    const { board } = setup({
      ticketLimit: { capacity: 1, refillMs: 60_000 },
      ticketGlobalLimit: { capacity: 2, refillMs: 60_000 },
    });
    await board.issueTicket(CLIENT);
    for (let i = 0; i < 5; i++) {
      await expect(board.issueTicket(CLIENT)).rejects.toMatchObject({ code: 'rate_limited' });
    }
    await board.issueTicket('198.51.100.1'); // the global bucket still has room
  });

  it('logs the shared ticket limit turning clients away, at most every 10 minutes', async () => {
    const lines: string[] = [];
    const { board, clock } = setup({
      ticketGlobalLimit: { capacity: 1, refillMs: 3_600_000 },
      log: (line) => lines.push(line),
    });
    await board.issueTicket('198.51.100.1');
    for (let n = 2; n <= 4; n++) {
      await expect(board.issueTicket(`198.51.100.${n}`)).rejects.toMatchObject({
        code: 'rate_limited',
      });
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ticket limit shared by all clients refused 1 request /);
    clock.now += 10 * 60_000;
    await expect(board.issueTicket('198.51.100.5')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/refused 3 requests/);
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
    const res = await s.board.submit(CLIENT, submission(runId, { name: '  Mi\u200bsha  ' }));
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

  it('rejects an expired ticket, from its advertised expiry on', async () => {
    const s = setup();
    const { runId, expiresAt } = await s.board.issueTicket(CLIENT);
    s.clock.now = expiresAt;
    expect(expiresAt - T0).toBe(SOLO_TICKET_TTL_MS);
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

  it('rejects a command past 32 bits, which a mask test alone would let through', async () => {
    const s = setup();
    const runId = await playRun(s);
    // 2**32 + c truncates to c under bitwise operators: a valid-looking mask.
    const [first, ...rest] = FIXTURE.inputs;
    const replay = { ...FIXTURE, inputs: [[first![0], 2 ** 32 + first![1]], ...rest] };
    await expect(s.board.submit(CLIENT, submission(runId, { replay }))).rejects.toMatchObject({
      status: 422,
      code: 'invalid_replay',
    });
  });

  it.each([
    ['a non-object', [1, 2], 'bad_request'],
    ['a missing run id', { name: 'x', replay: FIXTURE }, 'bad_request'],
    ['a malformed run id', { runId: 'nope', name: 'x', replay: FIXTURE }, 'bad_request'],
    ['a blank name', { runId: rid(1), name: ' \u200b ', replay: FIXTURE }, 'bad_name'],
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
      headers: { 'Retry-After': '5' },
    });
    release();
    await first;
    // Same score, later run: second place.
    const second = await s.board.submit(CLIENT, submission(b.runId));
    expect(second.standing.all).toEqual({ rank: 2, total: 2 });
  });

  it('verifies concurrent copies of a run once and answers them all alike', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = new SoloVerifier({ sliceTicks: 100, yieldFn: () => gate });
    const s = setup({ verifier });
    const runId = await playRun(s);
    const copies = [1, 2, 3, 4, 5].map(() => s.board.submit(CLIENT, submission(runId)));
    await vi.waitFor(() => expect(verifier.queued).toBe(1));
    // A bad copy racing the good one (another seed) can't drop the ticket from under it.
    const wrongSeed = { ...FIXTURE, seed: FIXTURE.seed + 1 };
    copies.push(s.board.submit(CLIENT, submission(runId, { replay: wrongSeed })));
    expect(verifier.queued).toBe(1); // still just the one verification
    release();
    const results = await Promise.all(copies);
    expect(results[0]).toMatchObject({ id: 1, score: 48 });
    for (const res of results) expect(res).toEqual(results[0]);
    expect(await s.store.countScores(ALL_TIME)).toBe(1);
    // Done checking: a later retry is answered from the store as usual.
    expect(await s.board.submit(CLIENT, submission(runId))).toEqual(results[0]);
  });

  it("gives a copy that arrives mid-check the first one's failure", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = new SoloVerifier({ sliceTicks: 100, yieldFn: () => gate });
    const s = setup({ verifier });
    const runId = await playRun(s);
    const first = s.board.submit(CLIENT, submission(runId, { replay: truncatedFixture() }));
    await vi.waitFor(() => expect(verifier.queued).toBe(1));
    const copy = s.board.submit(CLIENT, submission(runId));
    release();
    await expect(first).rejects.toMatchObject({ status: 422, code: 'invalid_replay' });
    await expect(copy).rejects.toMatchObject({ status: 422, code: 'invalid_replay' });
    expect(verifier.queued).toBe(0);
  });

  it('rate-limits submissions per client', async () => {
    const s = setup({ submitLimit: { capacity: 1, refillMs: 60_000 } });
    await expect(s.board.submit(CLIENT, {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(s.board.submit(CLIENT, {})).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      headers: { 'Retry-After': '60' }, // this limiter's refill, not a fixed guess
    });
  });

  it('also limits submissions per IPv6 /48 and across all clients', async () => {
    const lines: string[] = [];
    const s = setup({
      submitSiteLimit: { capacity: 2, refillMs: 60_000 },
      submitGlobalLimit: { capacity: 3, refillMs: 60_000 },
      log: (line) => lines.push(line),
    });
    const in48 = (n: number) => clientKey(`2001:db8:1:${n.toString(16)}::1`);
    for (let n = 0; n < 2; n++) {
      await expect(s.board.submit(in48(n), {})).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(s.board.submit(in48(9), {})).rejects.toMatchObject({ status: 429 });
    // The site's refusal spent nothing shared: one submission left for everyone.
    await expect(s.board.submit(CLIENT, {})).rejects.toMatchObject({ code: 'bad_request' });
    await expect(s.board.submit('198.51.100.1', {})).rejects.toMatchObject({ status: 429 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/submission limit shared by all clients/);
  });

  it('spends a submission on admission, before there is a body', async () => {
    const s = setup({ submitLimit: { capacity: 1, refillMs: 60_000 } });
    s.board.admitSubmission(CLIENT);
    // A second sent before the first's body arrives is refused straight away.
    let refusal: unknown;
    try {
      s.board.admitSubmission(CLIENT);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toMatchObject({ status: 429, headers: { 'Retry-After': '60' } });
    // The one let in goes on without spending again.
    await expect(s.board.submitAdmitted({})).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses a replay padded with more input than anyone can press, keeping the ticket', async () => {
    const s = setup();
    const runId = await playRun(s);
    // A cursor wiggle: a change every tick, moving nothing anywhere.
    const inputs = Array.from({ length: FIXTURE.ticks - 1 }, (_, i) => [
      1,
      i % 2 === 0 ? CC_LEFT : CC_RIGHT,
    ]);
    const replay = { ...FIXTURE, inputs };
    const res = s.board.submit(CLIENT, submission(runId, { replay }));
    await expect(res).rejects.toMatchObject({ status: 422, code: 'invalid_replay' });
    await expect(res).rejects.toThrow(/faster than anyone/);
    expect((await s.board.submit(CLIENT, submission(runId))).score).toBe(48);
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

    const scores = await board.scores(CLIENT, query());
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
    const mult = await board.scores(CLIENT, query({ board: 'mult' }));
    expect(mult.entries.map((e) => e.id)).toEqual([3, 4, 2, 1]);
  });

  it('serves this month, or any month asked for', async () => {
    const { board, store } = setup();
    await addRun(store, 1, { score: 90, createdAt: Date.UTC(2026, 7, 20) });
    await addRun(store, 2, { score: 10, createdAt: Date.UTC(2026, 8, 2) });

    const now = await board.scores(CLIENT, query({ period: 'month' }));
    expect(now).toMatchObject({ period: 'month', month: '2026-09', total: 1 });
    expect(now.entries.map((e) => e.id)).toEqual([2]);
    const august = await board.scores(CLIENT, query({ month: '2026-08' }));
    expect(august).toMatchObject({ period: 'month', month: '2026-08', total: 1 });
    expect(august.entries.map((e) => e.id)).toEqual([1]);
    expect((await board.scores(CLIENT, query())).total).toBe(2);
  });

  it("defaults to the original's table lengths and honours a limit", async () => {
    const { board, store } = setup();
    for (let n = 1; n <= 35; n++) await addRun(store, n, { score: n, topMultiplier: n });
    expect((await board.scores(CLIENT, query())).entries).toHaveLength(30);
    expect((await board.scores(CLIENT, query({ board: 'mult' }))).entries).toHaveLength(10);
    expect((await board.scores(CLIENT, query({ limit: '5' }))).entries).toHaveLength(5);
    expect((await board.scores(CLIENT, query())).total).toBe(35);
  });

  it('rate-limits board requests per client', async () => {
    const { board } = setup({ scoresLimit: { capacity: 2, refillMs: 5_000 } });
    await board.scores(CLIENT, query());
    await board.scores(CLIENT, query());
    await expect(board.scores(CLIENT, query())).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      headers: { 'Retry-After': '5' },
    });
    await board.scores('198.51.100.1', query());
  });

  it('reuses a board response for a few seconds, or until a run is recorded here', async () => {
    const s = setup();
    const topScores = vi.spyOn(s.store, 'topScores');
    const runId = await playRun(s);
    const first = await s.board.scores(CLIENT, query({ period: 'month' }));
    // The same query normalized (this month, named), and at any limit: one load.
    expect(await s.board.scores(CLIENT, query({ month: '2026-09' }))).toEqual(first);
    await s.board.scores(CLIENT, query({ period: 'month', limit: '3' }));
    expect(topScores).toHaveBeenCalledTimes(1);
    await s.board.scores(CLIENT, query({ board: 'mult' })); // another board: its own entry
    expect(topScores).toHaveBeenCalledTimes(2);

    await s.board.submit(CLIENT, submission(runId));
    const after = await s.board.scores(CLIENT, query({ period: 'month' }));
    expect(after.total).toBe(1);
    expect(topScores).toHaveBeenCalledTimes(3);

    // A change made elsewhere (the admin CLI hiding a run) shows once it expires.
    await s.store.setHidden(1, true);
    expect((await s.board.scores(CLIENT, query({ period: 'month' }))).total).toBe(1);
    s.clock.now += DEFAULT_SCORES_CACHE_MS;
    expect((await s.board.scores(CLIENT, query({ period: 'month' }))).total).toBe(0);
  });

  it('leaves hidden runs off the boards', async () => {
    const { board, store } = setup();
    const id = await addRun(store, 1, { score: 90 });
    await addRun(store, 2, { score: 10 });
    await store.setHidden(id!, true);
    const scores = await board.scores(CLIENT, query());
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
    await expect(board.scores(CLIENT, query(q))).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
    });
  });

  it('serves a visible run with its replay', async () => {
    const s = setup();
    const runId = await playRun(s);
    const { id } = await s.board.submit(CLIENT, submission(runId));
    const res = JSON.parse(await s.board.replay(CLIENT, String(id))) as SoloReplayResponse;
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
      await expect(s.board.replay(CLIENT, idText)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
    }
  });

  it('rate-limits replay requests per client', async () => {
    const { board } = setup({ replayLimit: { capacity: 1, refillMs: 2_000 } });
    await expect(board.replay(CLIENT, '1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(board.replay(CLIENT, '1')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      headers: { 'Retry-After': '2' },
    });
    await expect(board.replay('198.51.100.1', '1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it("serves a visible run's share card, with its places now", async () => {
    const s = setup();
    const { id } = await s.board.submit(CLIENT, submission(await playRun(s)));
    expect(await s.board.shareCard(CLIENT, String(id))).toEqual({
      entry: {
        id,
        name: 'misha',
        score: 48,
        topMultiplier: 3,
        ticks: FIXTURE.ticks,
        createdAt: s.clock.now,
      },
      month: '2026-09',
      standing: { all: { rank: 1, total: 1 }, month: { rank: 1, total: 1 } },
    });

    await s.store.setHidden(id, true);
    for (const idText of [String(id), '999', '0', 'abc', '1e3']) {
      expect(await s.board.shareCard(CLIENT, idText)).toBeNull();
    }
  });

  it('gives no card for a run a moderator hides mid-lookup', async () => {
    const s = setup();
    const { id } = await s.board.submit(CLIENT, submission(await playRun(s)));
    const lookup = s.store.visibleScore.bind(s.store);
    s.store.visibleScore = async (runId) => {
      const found = await lookup(runId);
      await s.store.setHidden(runId, true); // the admin CLI, between the reads
      return found;
    };
    expect(await s.board.shareCard(CLIENT, String(id))).toBeNull();
  });

  it('rate-limits share-page requests per client', async () => {
    const { board } = setup({ shareLimit: { capacity: 1, refillMs: 1_000 } });
    expect(await board.shareCard(CLIENT, '1')).toBeNull();
    await expect(board.shareCard(CLIENT, '1')).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
    expect(await board.shareCard('198.51.100.1', '1')).toBeNull();
  });

  it("keeps a run's replay a week, then only if a board shows it", async () => {
    const s = setup();
    // The top 100 of all time and of September, on both boards.
    const listed: number[] = [];
    for (let n = 1; n <= 100; n++) {
      listed.push((await addRun(s.store, 1000 + n, { score: 100 + n, topMultiplier: 5 }))!);
    }
    // Off every board: 101st on the score boards, 102nd on the chain boards.
    const low = (await addRun(s.store, 1101, { score: 1, topMultiplier: 1 }))!;
    // Off the all-time boards, but the best of its month.
    const august = (await addRun(s.store, 1102, { score: 1, createdAt: Date.UTC(2026, 7, 20) }))!;
    // A low score, but the best chain of all time.
    const chain = (await addRun(s.store, 1103, { score: 0, topMultiplier: 9 }))!;

    s.clock.now += DEFAULT_REPLAY_GRACE_MS;
    // Recording a run sets off the sweep; the new run is well inside its week.
    const { id: fresh } = await s.board.submit(CLIENT, submission(await playRun(s)));
    expect(await s.store.getReplay(low)).toBeNull();
    await expect(s.board.replay(CLIENT, String(low))).rejects.toMatchObject({ status: 404 });
    expect(await s.store.scoreByRun(rid(1101))).toMatchObject({ id: low, hidden: false });
    for (const id of [...listed, august, chain, fresh]) {
      expect(await s.store.getReplay(id)).not.toBeNull();
    }
    // Kept or dropped, every run of age is settled: the next sweep moves on.
    expect(await s.store.replayCandidates(s.clock.now - DEFAULT_REPLAY_GRACE_MS, 1000)).toEqual([]);
  });

  it('runs one replay sweep at a time', async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const candidates = s.store.replayCandidates.bind(s.store);
    const sweeps = vi
      .spyOn(s.store, 'replayCandidates')
      .mockImplementation(async (before, limit) => {
        await gate;
        return candidates(before, limit);
      });
    const [a, b, c] = [
      await s.board.issueTicket(CLIENT),
      await s.board.issueTicket(CLIENT),
      await s.board.issueTicket(CLIENT),
    ];
    s.clock.now += PLAY_MS;
    const first = s.board.submit(CLIENT, submission(a.runId));
    await vi.waitFor(() => expect(sweeps).toHaveBeenCalledTimes(1));
    // Past the hourly spacing, but the first sweep is still going: no second one.
    s.clock.now += 2 * 60 * 60 * 1000;
    expect((await s.board.submit(CLIENT, submission(b.runId))).score).toBe(48);
    expect(sweeps).toHaveBeenCalledTimes(1);
    release();
    await first;
    // Once it's done, the next run due a sweep gets one.
    s.clock.now += 2 * 60 * 60 * 1000;
    await s.board.submit(CLIENT, submission(c.runId));
    expect(sweeps).toHaveBeenCalledTimes(2);
  });
});

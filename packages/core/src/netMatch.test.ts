import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CC_ADVANCE } from './controller.js';
import { NetMatch, NetMatchRunner } from './netMatch.js';

/** A recorded match: the seed and each seat's inputs as `[tickDelta, command]` changes. */
interface MatchFixture {
  seed: number;
  ticks: number;
  inputs: [[number, number][], [number, number][]];
}

/** Expand `[tickDelta, command]` changes (the solo replay encoding) to one command per tick. */
function expand(changes: [number, number][], ticks: number): number[] {
  const frames: number[] = [];
  let held = 0;
  for (const [delta, command] of changes) {
    for (let i = 1; i < delta; i++) frames.push(held);
    held = command;
    frames.push(held);
  }
  while (frames.length < ticks) frames.push(held);
  return frames;
}

/** The golden fixture's seed and both seats' per-tick ledgers. */
function loadFixture(): { seed: number; ticks: number; ledgers: [number[], number[]] } {
  const path = fileURLToPath(new URL('./fixtures/net-hard-medium-42.match.json', import.meta.url));
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as MatchFixture;
  return {
    seed: fixture.seed,
    ticks: fixture.ticks,
    ledgers: [expand(fixture.inputs[0], fixture.ticks), expand(fixture.inputs[1], fixture.ticks)],
  };
}

/** The fixture's result: seat 0 wins on tick 2409. */
const FIXTURE_END = { winner: 0, tick: 2409 };
const FIXTURE_DIGESTS = [3459585470, 3315938223];

/** Step with each seat holding a fixed command until the match ends (or `cap` ticks). */
function holdUntilDecided(match: NetMatch, command0: number, command1: number, cap = 20_000) {
  let ended = null;
  while (!ended && match.tick < cap) ended = match.step(command0, command1);
  return ended;
}

describe('NetMatch', () => {
  it('starts both seats from the match seed', () => {
    const match = new NetMatch(1234);
    expect(match.tick).toBe(0);
    expect(match.outcome).toBeNull();
    expect(match.sims[0].digest()).toBe(match.sims[1].digest());
  });

  it('awards the game to the seat that did not lose', () => {
    const left = new NetMatch(99);
    expect(holdUntilDecided(left, CC_ADVANCE, 0)).toMatchObject({ winner: 1 });
    const right = new NetMatch(99);
    expect(holdUntilDecided(right, 0, CC_ADVANCE)).toMatchObject({ winner: 0 });
    // The same inputs end on the same tick from either side.
    expect(right.outcome!.tick).toBe(left.outcome!.tick);
  });

  it('calls a same-tick double loss a draw', () => {
    const match = new NetMatch(99);
    const ended = holdUntilDecided(match, CC_ADVANCE, CC_ADVANCE);
    expect(ended).toEqual({ winner: null, tick: match.tick });
    expect(match.sims[0].lost && match.sims[1].lost).toBe(true);
  });

  it('refuses to step a decided match', () => {
    const match = new NetMatch(5);
    const ended = holdUntilDecided(match, CC_ADVANCE, 0)!;
    expect(() => match.step(0, 0)).toThrow(/ended on tick/);
    expect(match.tick).toBe(ended.tick);
  });

  // Hard (seat 0) against medium (seat 1), both bots deciding from the start of
  // each tick. Both seats send garbage, so this pins the cross-wiring and the
  // step order as well as the rules. If a rules change breaks it, update the
  // expected values and bump SIM_VERSION.
  it('matches the golden fixture', () => {
    const { seed, ticks, ledgers } = loadFixture();

    const sent = [0, 0];
    const match = new NetMatch(seed, {
      sendGarbage: (from) => sent[from]!++,
      sendSpecialGarbage: (from) => sent[from]!++,
    });
    let ended = null;
    for (let t = 0; t < ticks; t++) {
      expect(ended).toBeNull();
      ended = match.step(ledgers[0][t]!, ledgers[1][t]!);
    }

    expect(ended).toEqual(FIXTURE_END);
    expect(match.sims.map((sim) => sim.digest())).toEqual(FIXTURE_DIGESTS);
    expect(sent[0]).toBeGreaterThan(0);
    expect(sent[1]).toBeGreaterThan(0);
  });
});

describe('NetMatchRunner', () => {
  it('plays a match out in slices', () => {
    const { seed, ledgers } = loadFixture();
    const runner = new NetMatchRunner(seed, ledgers);
    let slices = 1;
    while (!runner.advance(500)) slices++;
    expect(slices).toBe(5);
    expect(runner.result()).toEqual({ outcome: FIXTURE_END, tick: 2409, digests: FIXTURE_DIGESTS });
  });

  it('stops at the end of the match, ignoring frames past it', () => {
    const { seed, ledgers } = loadFixture();
    const padded: [number[], number[]] = [
      [...ledgers[0], 0, 0],
      [...ledgers[1], 0],
    ];
    const runner = new NetMatchRunner(seed, padded);
    expect(runner.advance(10_000)).toBe(true);
    expect(runner.result().outcome).toEqual(FIXTURE_END);
  });

  it('stops where the shorter ledger runs out, the match still in play', () => {
    const { seed, ledgers } = loadFixture();
    const runner = new NetMatchRunner(seed, [ledgers[0], ledgers[1].slice(0, 1000)]);
    expect(runner.advance(10_000)).toBe(true);
    const played = new NetMatch(seed);
    for (let t = 0; t < 1000; t++) played.step(ledgers[0][t]!, ledgers[1][t]!);
    expect(runner.result()).toEqual({
      outcome: null,
      tick: 1000,
      digests: [played.sims[0].digest(), played.sims[1].digest()],
    });
  });

  it('stops at endTick', () => {
    const { seed, ledgers } = loadFixture();
    const runner = new NetMatchRunner(seed, ledgers, 64);
    expect(runner.advance(10_000)).toBe(true);
    expect(runner.result()).toMatchObject({ outcome: null, tick: 64 });
  });

  it.each([0, -1, 1.5, NaN])('rejects a budget of %s', (budget) => {
    const { seed, ledgers } = loadFixture();
    const runner = new NetMatchRunner(seed, ledgers);
    expect(() => runner.advance(budget)).toThrow(RangeError);
    expect(() => runner.result()).toThrow(/not been played out/);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AiController } from './aiController.js';
import { ActionState, CC_ADVANCE, CC_LEFT, CC_SWAP } from './controller.js';
import { GameSim } from './gameSim.js';
import { ScoreState } from './scoreState.js';
import {
  parseSoloReplay,
  runSoloReplay,
  SOLO_REPLAY_MAX_TICKS,
  SOLO_REPLAY_VERSION,
  SoloRecorder,
  SoloReplayError,
  SoloReplayRunner,
  verifySoloReplay,
  type SoloReplay,
} from './soloReplay.js';

/**
 * Play a solo game to a loss with the AI, recording it and scoring it the way
 * the solo screen does: score events drained in frame-sized batches, the
 * backlog dripping, then a flush at game over. From `forceAdvanceAt` on the
 * stack is raised every tick, so the game ends quickly.
 */
function playAiGame(seed: number, forceAdvanceAt: number) {
  const sim = new GameSim(seed);
  const ai = new AiController('hard', seed);
  const recorder = new SoloRecorder(seed);
  const score = new ScoreState();
  while (!sim.lost) {
    for (let frame = 0; frame < 3 && !sim.lost; frame++) {
      let command = ai.decide(sim).state;
      if (recorder.tickCount >= forceAdvanceAt) command |= CC_ADVANCE;
      recorder.record(command);
      sim.step(new ActionState(command));
    }
    for (const ev of sim.drainScoreEvents()) score.report(ev);
    score.timeStep(3);
  }
  score.flush();
  return { replay: recorder.replay(), sim, score };
}

/** A copy of `replay` as parsed JSON, with fields overridden. */
const json = (replay: SoloReplay, over: Record<string, unknown> = {}): unknown =>
  JSON.parse(JSON.stringify({ ...replay, ...over }));

describe('SoloRecorder', () => {
  it('stores input changes as [tickDelta, command] pairs', () => {
    const rec = new SoloRecorder(-1);
    for (const command of [0, 0, CC_LEFT, CC_LEFT, 0, CC_SWAP]) rec.record(command);
    expect(rec.replay()).toEqual({
      version: SOLO_REPLAY_VERSION,
      seed: 0xffffffff,
      ticks: 6,
      inputs: [
        [3, CC_LEFT],
        [2, 0],
        [1, CC_SWAP],
      ],
    });
  });

  it('hands out a snapshot that later recording does not change', () => {
    const rec = new SoloRecorder(1);
    rec.record(CC_LEFT);
    const snapshot = rec.replay();
    rec.record(0);
    expect(snapshot.ticks).toBe(1);
    expect(snapshot.inputs).toEqual([[1, CC_LEFT]]);
  });
});

describe('runSoloReplay', () => {
  it('reproduces a recorded game and the score the solo screen showed', () => {
    const { replay, sim, score } = playAiGame(12345, 1500);
    const result = runSoloReplay(parseSoloReplay(json(replay)));
    expect(result).toEqual({
      ticks: sim.clock.time_step,
      score: score.score,
      topMultiplier: score.topMultiplier,
      digest: sim.digest(),
    });
    expect(result.score).toBeGreaterThan(0);
  });

  it('gives the same result run a slice at a time', () => {
    const { replay } = playAiGame(12345, 1500);
    const runner = new SoloReplayRunner(replay);
    let slices = 1;
    while (!runner.advance(97)) slices++;
    expect(slices).toBe(Math.ceil(replay.ticks / 97));
    expect(runner.result()).toEqual(runSoloReplay(replay));
  });

  // If a rules change breaks this, update the expected values and bump
  // SIM_VERSION: runs recorded under the old rules no longer replay the same.
  it('matches the golden fixture', () => {
    const path = fileURLToPath(new URL('./fixtures/solo-hard-2026.replay.json', import.meta.url));
    const fixture: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(verifySoloReplay(fixture)).toEqual({
      ticks: 2757,
      score: 48,
      topMultiplier: 3,
      digest: 3205557052,
    });
  });

  // playAiGame(459, 4000): a longer run with a gray-garbage elimination and an
  // x6 chain. Special blocks only come from X-mode creep, which isn't ported.
  it('matches the longer golden fixture', () => {
    const path = fileURLToPath(new URL('./fixtures/solo-hard-459.replay.json', import.meta.url));
    const fixture: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(verifySoloReplay(fixture)).toEqual({
      ticks: 4445,
      score: 206,
      topMultiplier: 6,
      digest: 3526844717,
    });
  });

  it('rejects a game that is still in play at the last tick', () => {
    const { replay } = playAiGame(777, 1500);
    // Drop the last tick (and an input change on it, if there is one).
    let tick = 0;
    const inputs = replay.inputs.filter(([delta]) => (tick += delta) < replay.ticks);
    const truncated = { ...replay, ticks: replay.ticks - 1, inputs };
    expect(() => runSoloReplay(truncated)).toThrow(/still in play/);
  });

  it('rejects ticks past the loss', () => {
    const { replay } = playAiGame(777, 1500);
    expect(() => runSoloReplay({ ...replay, ticks: replay.ticks + 1 })).toThrow(/before the last/);
  });
});

describe('parseSoloReplay', () => {
  const base: SoloReplay = {
    version: SOLO_REPLAY_VERSION,
    seed: 42,
    ticks: 10,
    inputs: [
      [2, CC_LEFT],
      [3, 0],
    ],
  };

  it('returns a clean copy, dropping unknown fields', () => {
    expect(parseSoloReplay(json(base, { kind: 'crack-attack-solo-replay' }))).toEqual(base);
  });

  it.each([
    ['a non-object', null],
    ['another version', json(base, { version: 2 })],
    ['a negative seed', json(base, { seed: -1 })],
    ['a fractional seed', json(base, { seed: 1.5 })],
    ['zero ticks', json(base, { ticks: 0 })],
    ['too many ticks', json(base, { ticks: SOLO_REPLAY_MAX_TICKS + 1 })],
    ['inputs that are not an array', json(base, { inputs: {} })],
    ['a malformed pair', json(base, { inputs: [[1, CC_LEFT, 0]] })],
    ['a zero tick delta', json(base, { inputs: [[0, CC_LEFT]] })],
    ['a change past the last tick', json(base, { inputs: [[11, CC_LEFT]] })],
    ['a stray command bit', json(base, { inputs: [[1, 1 << 6]] })],
    // Bitwise operators truncate to int32: 2**32 & ~63 is 0.
    ['a command past 32 bits', json(base, { inputs: [[1, 2 ** 32]] })],
    ['a change that repeats the held command', json(base, { inputs: [[1, 0]] })],
  ])('rejects %s', (_label, value) => {
    expect(() => parseSoloReplay(value)).toThrow(SoloReplayError);
  });

  it('honours a smaller tick cap', () => {
    expect(() => parseSoloReplay(json(base), 9)).toThrow(SoloReplayError);
  });
});

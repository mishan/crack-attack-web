import { describe, expect, it } from 'vitest';
import { ActionState, AiController, GameSim } from '@crack-attack/core';
import { analyzeReplay, validateReplay, type VsAiReplay } from './analyze.js';

/**
 * Synthesize a replay by letting an easy bot play the "human" seat against the
 * medium AI seat, recording its inputs exactly as the client does — inputs are
 * inputs, whether a hand or a bot produced them.
 */
function synthesizeReplay(seed: number, ticks: number): VsAiReplay {
  const humanSim = new GameSim(seed);
  const aiSim = new GameSim(seed);
  const human = new AiController('easy');
  const ai = new AiController('medium');
  const link = (from: GameSim, to: GameSim): void => {
    from.garbageGenerator.outSink = {
      sendGarbage: (h, w, f) => to.garbageGenerator.addToQueue(h, w, f, from.clock.time_step),
      sendSpecialGarbage: (f) => to.garbageGenerator.addToQueue(1, 1, f, from.clock.time_step),
    };
  };
  link(humanSim, aiSim);
  link(aiSim, humanSim);

  const actions: { tick: number; command: number }[] = [];
  let t = 0;
  for (; t < ticks && !humanSim.lost && !aiSim.lost;) {
    t++;
    const act = human.decide(humanSim);
    if (act.state !== 0) actions.push({ tick: t, command: act.state });
    humanSim.step(new ActionState(act.state));
    aiSim.step(ai.decide(aiSim));
  }
  return {
    kind: 'crack-attack-vs-ai-replay',
    version: 1,
    seed,
    difficulty: 'medium',
    ticks: t,
    actions,
  };
}

describe('replay-analyze', () => {
  it('reconstructs the game and reports plausible, consistent stats', () => {
    const replay = synthesizeReplay(7, 8000);
    const a = analyzeReplay(replay);
    expect(a.ticks).toBe(replay.ticks);
    // Both seats actually played.
    expect(a.human.swaps).toBeGreaterThan(0);
    expect(a.ai.swaps).toBeGreaterThan(0);
    expect(a.human.sampledTicks).toBeGreaterThan(0);
    // Timeline entries match the seat counters.
    const humanFires = a.timeline.filter((e) => e.seat === 'human').length;
    expect(humanFires).toBe(a.human.chains + a.human.combos);
  });

  it('is deterministic: analyzing the same replay twice gives identical reports', () => {
    const replay = synthesizeReplay(11, 5000);
    expect(analyzeReplay(replay)).toEqual(analyzeReplay(replay));
  });

  it('validateReplay rejects malformed files with useful messages', () => {
    expect(() => validateReplay(null)).toThrow(/JSON object/);
    expect(() => validateReplay({ kind: 'nope' })).toThrow(/unexpected kind/);
    expect(() => validateReplay({ kind: 'crack-attack-vs-ai-replay', version: 2 })).toThrow(
      /version/,
    );
    expect(() =>
      validateReplay({
        kind: 'crack-attack-vs-ai-replay',
        version: 1,
        seed: 1,
        difficulty: 'brutal',
        ticks: 10,
        actions: [],
      }),
    ).toThrow(/difficulty/);
  });
});

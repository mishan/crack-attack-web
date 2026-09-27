/**
 * aiVsAi.ts — the deterministic heart of the AI-vs-AI demo.
 *
 * A core `NetMatch` (the same two-board match netplay and `tools/ai-arena`
 * play), each side driven by its own `AiController`, with a distinct judgment
 * seed derived from the match seed and seat. The boards stay fair while equivalent
 * decisions stop mirroring. DOM-free and replayable: a `(seed, tierA, tierB)`
 * triple always plays out the same game.
 */

import {
  AiController,
  NetMatch,
  aiDecisionSeed,
  type GameSim,
  type AiDifficultyLevel,
  type AiTuning,
} from '@crack-attack/core';

/**
 * How a match ended: seat 0 (left) or seat 1 (right) won, a same-tick double
 * loss (the netplay convention), or the tick cap ran out.
 */
export type AiVsAiOutcome = 0 | 1 | 'draw' | 'timeout';

/** Tick cap so a stalemate can't stall the demo: 10 minutes at 50 Hz (the arena default). */
export const AI_VS_AI_MAX_TICKS = 30_000;

/** One bot-vs-bot match, advanced a tick at a time. */
export class AiVsAiMatch {
  private readonly match: NetMatch;
  private readonly ais: readonly [AiController, AiController];
  private result: AiVsAiOutcome | null = null;

  constructor(
    readonly seed: number,
    a: AiDifficultyLevel | AiTuning,
    b: AiDifficultyLevel | AiTuning,
    readonly maxTicks = AI_VS_AI_MAX_TICKS,
  ) {
    this.match = new NetMatch(seed);
    this.ais = [
      new AiController(a, aiDecisionSeed(seed, 0)),
      new AiController(b, aiDecisionSeed(seed, 1)),
    ];
  }

  /** Both seats' sims: seat 0 (left), seat 1 (right). */
  get sims(): readonly [GameSim, GameSim] {
    return this.match.sims;
  }

  /** Gameplay ticks played so far. */
  get ticks(): number {
    return this.match.tick;
  }

  /** The result, or null while the match is still live. */
  get outcome(): AiVsAiOutcome | null {
    return this.result;
  }

  /**
   * Advance both boards one tick: both bots decide, then the match steps, as
   * in netplay. A no-op once the match is decided.
   */
  step(): AiVsAiOutcome | null {
    if (this.result !== null) return this.result;
    const [simA, simB] = this.match.sims;
    const a = this.ais[0].decide(simA).state;
    const b = this.ais[1].decide(simB).state;
    const ended = this.match.step(a, b);
    if (ended) this.result = ended.winner ?? 'draw';
    else if (this.match.tick >= this.maxTicks) this.result = 'timeout';
    return this.result;
  }
}

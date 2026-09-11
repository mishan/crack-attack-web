/**
 * aiVsAi.ts — the deterministic heart of the AI-vs-AI demo.
 *
 * Two `GameSim`s share a seed (identical starting boards), their garbage ports
 * are cross-wired exactly as in netplay / `aiMatch` / `tools/ai-arena`, and each
 * side is driven by its own `AiController`, with a distinct judgment seed
 * derived from the match seed and seat. The boards stay fair while equivalent
 * decisions stop mirroring. DOM-free and replayable: a `(seed, tierA, tierB)`
 * triple always plays out the same game.
 */

import {
  AiController,
  GameSim,
  aiDecisionSeed,
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

/** Route `from`'s outgoing garbage into `to`'s queue (netplay's seam, but local). */
function link(from: GameSim, to: GameSim): void {
  from.garbageGenerator.outSink = {
    sendGarbage: (h, w, f) => to.garbageGenerator.addToQueue(h, w, f, from.clock.time_step),
    sendSpecialGarbage: (f) => to.garbageGenerator.addToQueue(1, 1, f, from.clock.time_step),
  };
}

/** One bot-vs-bot match, advanced a tick at a time. */
export class AiVsAiMatch {
  readonly sims: readonly [GameSim, GameSim];
  private readonly ais: readonly [AiController, AiController];
  private tickCount = 0;
  private result: AiVsAiOutcome | null = null;

  constructor(
    readonly seed: number,
    a: AiDifficultyLevel | AiTuning,
    b: AiDifficultyLevel | AiTuning,
    readonly maxTicks = AI_VS_AI_MAX_TICKS,
  ) {
    const simA = new GameSim(seed);
    const simB = new GameSim(seed);
    link(simA, simB);
    link(simB, simA);
    this.sims = [simA, simB];
    this.ais = [
      new AiController(a, aiDecisionSeed(seed, 0)),
      new AiController(b, aiDecisionSeed(seed, 1)),
    ];
  }

  /** Gameplay ticks played so far. */
  get ticks(): number {
    return this.tickCount;
  }

  /** The result, or null while the match is still live. */
  get outcome(): AiVsAiOutcome | null {
    return this.result;
  }

  /**
   * Advance both boards one tick (seat 0 first, as in the arena). Losses are
   * checked after the full tick so a same-tick double loss reads as a draw.
   * A no-op once the match is decided.
   */
  step(): AiVsAiOutcome | null {
    if (this.result !== null) return this.result;
    const [simA, simB] = this.sims;
    simA.step(this.ais[0].decide(simA));
    simB.step(this.ais[1].decide(simB));
    this.tickCount++;
    if (simA.lost && simB.lost) this.result = 'draw';
    else if (simA.lost) this.result = 1;
    else if (simB.lost) this.result = 0;
    else if (this.tickCount >= this.maxTicks) this.result = 'timeout';
    return this.result;
  }
}

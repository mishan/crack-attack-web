/**
 * replays.ts — the scoreboard driver's replay factory: a finished solo run on
 * a ticket's seed, played headlessly and recorded as the solo screen records
 * it (core `SoloRecorder`), in the shapes docs/SCOREBOARD_SECURITY_REVIEW.md
 * measured. Plays in slices, yielding between them, so making a long AI run
 * doesn't stall the worker's other traffic.
 */

import {
  ActionState,
  AiController,
  CC_ADVANCE,
  CC_LEFT,
  CC_RIGHT,
  GameSim,
  SOLO_REPLAY_MAX_TICKS,
  SoloRecorder,
  type SoloReplay,
} from '@crack-attack/core';

export const REPLAY_KINDS = ['advance', 'idle', 'padded', 'ai'] as const;
/**
 * - `advance`: hold `CC_ADVANCE` and nothing else; the shortest valid game (~451 ticks).
 * - `idle`: no input at all; the creep ends it (~4,351 ticks).
 * - `padded`: no useful input, but an input change every `padEvery` ticks,
 *   the most a submission may carry: the biggest stored row per verify cost.
 * - `ai`: the hard AI plays for `aiTicks`, then holds advance to end it.
 */
export type ReplayKind = (typeof REPLAY_KINDS)[number];

export interface ReplayOptions {
  /** `ai`: ticks of real play. Default 9,000 (3 minutes). */
  aiTicks?: number | undefined;
  /** `padded`: ticks between input changes. Default 3, the densest the server accepts. */
  padEvery?: number | undefined;
  /** Ticks between yields. Default 1,000. */
  sliceTicks?: number | undefined;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Play a `kind` game on `seed` to its loss and return the replay. */
export async function makeReplay(
  kind: ReplayKind,
  seed: number,
  options: ReplayOptions = {},
): Promise<SoloReplay> {
  const aiTicks = options.aiTicks ?? 9_000;
  const padEvery = options.padEvery ?? 3;
  const sliceTicks = options.sliceTicks ?? 1_000;
  const sim = new GameSim(seed);
  const recorder = new SoloRecorder(seed);
  const ai = kind === 'ai' ? new AiController('hard', seed) : null;
  const action = new ActionState(0);

  for (let tick = 0; !sim.lost; tick++) {
    if (tick >= SOLO_REPLAY_MAX_TICKS) {
      throw new Error(`a ${kind} game on seed ${seed} outlasted the replay limit`);
    }
    if (tick > 0 && tick % sliceTicks === 0) await nextTurn();
    let command = 0;
    if (kind === 'advance') command = CC_ADVANCE;
    else if (kind === 'padded') command = Math.floor(tick / padEvery) % 2 ? CC_LEFT : CC_RIGHT;
    else if (ai) command = tick < aiTicks ? ai.decide(sim).state : CC_ADVANCE;
    recorder.record(command);
    action.state = command;
    sim.step(action);
  }
  return recorder.replay();
}

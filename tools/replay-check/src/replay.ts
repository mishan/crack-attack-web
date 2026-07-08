/**
 * replay.ts
 *
 * The replay format and runner. A {@link Replay} is a seed plus a sparse list of
 * per-tick input commands — tiny and portable, and identical in shape to what
 * the C++ `ActionRecorder` (CM_REPLAY) captures. Running it produces a
 * {@link DigestStream}: one digest per tick, starting with the initial position.
 *
 * This is the "same seed + action stream through the TS core" half of the
 * harness (BROWSER_PORT_PLAN.md §Verifying faithfulness). Diffing two streams
 * (see diff.ts) pinpoints the first divergent tick.
 */

import {
  ActionState,
  CC_ADVANCE,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SWAP,
  CC_UP,
  GameSim,
  noActions,
} from '@crack-attack/core';
import { digestState, snapshotState, type StateSnapshot } from './digest.js';

/** Every valid command bit OR'd together; a command must be a subset of these. */
const ALL_COMMAND_BITS = CC_LEFT | CC_RIGHT | CC_UP | CC_DOWN | CC_SWAP | CC_ADVANCE;

/** One input event: the `command` bitmask (CC_* flags) applied at `tick`. */
export interface ActionEvent {
  readonly tick: number;
  readonly command: number;
}

/**
 * A complete, replayable game input. `ticks` is how many `step`s to run; the
 * `actions` list is sparse — any tick without an entry runs with no input.
 */
export interface Replay {
  readonly seed: number;
  readonly ticks: number;
  readonly actions: readonly ActionEvent[];
}

/**
 * The output of running a replay: the seed it came from and `ticks + 1` digests
 * — index 0 is the starting position, index `t` is the state after `t` steps.
 */
export interface DigestStream {
  readonly seed: number;
  readonly digests: readonly string[];
}

/** Build a per-tick lookup of command bitmasks, rejecting out-of-range/dup ticks. */
function indexActions(replay: Replay): Map<number, number> {
  const byTick = new Map<number, number>();
  for (const a of replay.actions) {
    if (!Number.isInteger(a.tick) || a.tick < 1 || a.tick > replay.ticks) {
      throw new RangeError(`action tick ${a.tick} outside 1..${replay.ticks}`);
    }
    // Replays come from JSON; reject a malformed command up front rather than
    // letting a non-integer or a stray bit slip silently through `new
    // ActionState(command)` and produce a confusing digest divergence.
    if (!Number.isInteger(a.command) || a.command < 0 || (a.command & ~ALL_COMMAND_BITS) !== 0) {
      throw new RangeError(
        `action command ${a.command} at tick ${a.tick} is not a valid CC_* mask`,
      );
    }
    if (byTick.has(a.tick)) throw new Error(`duplicate action for tick ${a.tick}`);
    byTick.set(a.tick, a.command);
  }
  return byTick;
}

/**
 * Run `replay` through a fresh `GameSim` and return its digest stream. `visit`,
 * if given, is called with `(tick, sim)` after each step (tick 0 = initial) — a
 * hook for capturing full snapshots while a digest run is in flight.
 */
export function runReplay(
  replay: Replay,
  visit?: (tick: number, sim: GameSim) => void,
): DigestStream {
  if (!Number.isInteger(replay.ticks) || replay.ticks < 0) {
    throw new RangeError(`replay.ticks must be a non-negative integer (got ${replay.ticks})`);
  }
  const byTick = indexActions(replay);
  const sim = new GameSim(replay.seed);

  const digests: string[] = [digestState(sim)];
  if (visit) visit(0, sim);

  const held = noActions();
  for (let t = 1; t <= replay.ticks; t++) {
    const command = byTick.get(t);
    sim.step(command === undefined ? held : new ActionState(command));
    digests.push(digestState(sim));
    if (visit) visit(t, sim);
  }

  return { seed: replay.seed, digests };
}

/** Run `replay` and collect a full structured snapshot at every tick (debugging). */
export function snapshotStream(replay: Replay): StateSnapshot[] {
  const snaps: StateSnapshot[] = [];
  runReplay(replay, (_tick, sim) => snaps.push(snapshotState(sim)));
  return snaps;
}

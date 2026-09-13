/**
 * soloReplay.ts — record and verify solo games.
 *
 * A solo game is fully determined by its seed and its per-tick input stream, so
 * a {@link SoloReplay} is all it takes to reproduce one bit-exactly — and to
 * recompute its score without trusting whoever reports it. The client records
 * every run ({@link SoloRecorder}); the scoreboard server re-simulates a
 * submitted run ({@link verifySoloReplay}) and ranks the score _it_ computed.
 *
 * Inputs are stored as changes, not per-tick samples: `[tickDelta, command]`
 * means the held command becomes `command` `tickDelta` ticks after the previous
 * change (the first counts from tick 0, when nothing is held). A held key
 * repeats the same command every tick, so this keeps a long game to a few KB.
 * The encoding is canonical — deltas are ≥ 1 and every entry changes the
 * command — so a game has exactly one replay.
 *
 * Ticks count played sim steps. The 3-2-1 countdown and pauses never call
 * `GameSim.step`, so they aren't in a replay and can't affect its result.
 */

import { GC_STEPS_PER_SECOND } from './constants.js';
import {
  ActionState,
  CC_ADVANCE,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SWAP,
  CC_UP,
} from './controller.js';
import { GameSim } from './gameSim.js';
import { ScoreState } from './scoreState.js';

/** The replay format version; bump it when the encoding changes. */
export const SOLO_REPLAY_VERSION = 1;

/** Default cap on a replay's length: an hour of play. */
export const SOLO_REPLAY_MAX_TICKS = 60 * 60 * GC_STEPS_PER_SECOND;

/**
 * Version of the game rules a replay plays out under. Bump it whenever a change
 * makes an existing replay play out differently — the golden fixture test in
 * `soloReplay.test.ts` fails when that happens. A scoreboard server rejects
 * runs started under another version, and stored scores keep the version they
 * were verified with.
 */
export const SIM_VERSION = 1;

/** Every valid command bit OR'd together; a command must be a subset of these. */
const ALL_COMMAND_BITS = CC_LEFT | CC_RIGHT | CC_UP | CC_DOWN | CC_SWAP | CC_ADVANCE;

/** One input change: the held command becomes `command`, `tickDelta` ticks after the last change. */
export type SoloInputChange = readonly [tickDelta: number, command: number];

/** A complete solo game: its seed and inputs, ending in a loss on tick `ticks`. */
export interface SoloReplay {
  readonly version: number;
  readonly seed: number;
  /** Played ticks; the game is lost on the last one. */
  readonly ticks: number;
  readonly inputs: readonly SoloInputChange[];
}

/** What a verified solo game scored. */
export interface SoloResult {
  readonly ticks: number;
  /** The final score, backlog included (what the client shows at game over). */
  readonly score: number;
  readonly topMultiplier: number;
  /** `GameSim.digest()` of the final position. */
  readonly digest: number;
}

/** A replay that is malformed, or doesn't describe a finished game. */
export class SoloReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoloReplayError';
  }
}

/**
 * Records a solo run as it's played. Call {@link record} once per
 * `GameSim.step`, with the command that step is given.
 */
export class SoloRecorder {
  readonly seed: number;
  private ticks = 0;
  private lastChange = 0;
  private held = 0;
  private readonly inputs: SoloInputChange[] = [];

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** Record the command for the next played tick. */
  record(command: number): void {
    this.ticks++;
    if (command === this.held) return;
    this.inputs.push([this.ticks - this.lastChange, command]);
    this.lastChange = this.ticks;
    this.held = command;
  }

  /** Played ticks recorded so far. */
  get tickCount(): number {
    return this.ticks;
  }

  /** The run so far, as a replay. */
  replay(): SoloReplay {
    return {
      version: SOLO_REPLAY_VERSION,
      seed: this.seed,
      ticks: this.ticks,
      inputs: this.inputs.slice(),
    };
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Check that `value` (typically parsed JSON) is a well-formed replay no longer
 * than `maxTicks`, and return a clean copy (unknown fields dropped). Throws
 * {@link SoloReplayError} otherwise. Says nothing about how the game ends — see
 * {@link runSoloReplay}.
 */
export function parseSoloReplay(value: unknown, maxTicks = SOLO_REPLAY_MAX_TICKS): SoloReplay {
  if (typeof value !== 'object' || value === null) {
    throw new SoloReplayError('replay must be an object');
  }
  const { version, seed, ticks, inputs } = value as Record<string, unknown>;
  if (version !== SOLO_REPLAY_VERSION) {
    throw new SoloReplayError(`unsupported replay version ${String(version)}`);
  }
  if (!isInt(seed) || seed < 0 || seed > 0xffffffff) {
    throw new SoloReplayError('seed must be a uint32');
  }
  if (!isInt(ticks) || ticks < 1 || ticks > maxTicks) {
    throw new SoloReplayError(`ticks must be an integer in 1..${maxTicks}`);
  }
  if (!Array.isArray(inputs) || inputs.length > ticks) {
    throw new SoloReplayError('inputs must be an array of at most `ticks` changes');
  }

  const changes: SoloInputChange[] = [];
  let tick = 0;
  let held = 0;
  for (const entry of inputs as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new SoloReplayError('each input must be a [tickDelta, command] pair');
    }
    const [delta, command] = entry as unknown[];
    if (!isInt(delta) || delta < 1) {
      throw new SoloReplayError(`input tick delta must be a positive integer (after tick ${tick})`);
    }
    tick += delta;
    if (tick > ticks) {
      throw new SoloReplayError(`input at tick ${tick} is past the last tick ${ticks}`);
    }
    // Range before mask: bitwise operators truncate to int32, so 2**32 would
    // pass the mask test alone.
    if (
      !isInt(command) ||
      command < 0 ||
      command > ALL_COMMAND_BITS ||
      (command & ~ALL_COMMAND_BITS) !== 0
    ) {
      throw new SoloReplayError(`input at tick ${tick} is not a valid CC_* mask`);
    }
    if (command === held) {
      throw new SoloReplayError(`input at tick ${tick} doesn't change the command`);
    }
    changes.push([delta, command]);
    held = command;
  }

  return { version, seed, ticks, inputs: changes };
}

/**
 * Re-simulates a well-formed replay a slice at a time, so a server can verify a
 * long game without blocking its event loop ({@link runSoloReplay} runs one to
 * completion). The game must be lost exactly on its last tick: inputs past the
 * loss, or a game still in play at the end, throw {@link SoloReplayError}.
 * Scoring matches the solo screen: every combo report folds into a
 * {@link ScoreState}, and the backlog is flushed at the end.
 */
export class SoloReplayRunner {
  private readonly sim: GameSim;
  private readonly score = new ScoreState();
  private held = new ActionState(0);
  private next = 0;
  private changeAt: number;
  private tick = 0;

  constructor(private readonly replay: SoloReplay) {
    this.sim = new GameSim(replay.seed);
    this.changeAt = replay.inputs[0]?.[0] ?? Infinity;
  }

  /** Whether every tick has been played. */
  get done(): boolean {
    return this.tick >= this.replay.ticks;
  }

  /**
   * Play up to `budget` more ticks; returns {@link done}. `budget` must be a
   * positive integer: anything else would make no progress, and a
   * `while (!runner.advance(n))` loop would spin forever.
   */
  advance(budget: number): boolean {
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new RangeError(`budget must be a positive integer, not ${budget}`);
    }
    const { sim, replay } = this;
    const { inputs } = replay;
    const end = Math.min(replay.ticks, this.tick + budget);
    while (this.tick < end) {
      if (sim.lost) {
        throw new SoloReplayError(`the game was lost at tick ${this.tick}, before the last tick`);
      }
      const t = ++this.tick;
      if (t === this.changeAt) {
        this.held = new ActionState(inputs[this.next]![1]);
        this.next++;
        this.changeAt = this.next < inputs.length ? t + inputs[this.next]![0] : Infinity;
      }
      sim.step(this.held);
      for (const ev of sim.drainScoreEvents()) this.score.report(ev);
    }
    if (this.done && !sim.lost) {
      throw new SoloReplayError(`the game is still in play at the last tick ${replay.ticks}`);
    }
    return this.done;
  }

  /** The verified result, once {@link advance} has returned true. */
  result(): SoloResult {
    if (!this.done || !this.sim.lost) throw new Error('the replay has not finished');
    this.score.flush();
    return {
      ticks: this.replay.ticks,
      score: this.score.score,
      topMultiplier: this.score.topMultiplier,
      digest: this.sim.digest(),
    };
  }
}

/** Re-simulate a well-formed replay in one go and score it (see {@link SoloReplayRunner}). */
export function runSoloReplay(replay: SoloReplay): SoloResult {
  const runner = new SoloReplayRunner(replay);
  runner.advance(replay.ticks);
  return runner.result();
}

/** {@link parseSoloReplay} then {@link runSoloReplay}: what a scoreboard server calls. */
export function verifySoloReplay(value: unknown, maxTicks = SOLO_REPLAY_MAX_TICKS): SoloResult {
  return runSoloReplay(parseSoloReplay(value, maxTicks));
}

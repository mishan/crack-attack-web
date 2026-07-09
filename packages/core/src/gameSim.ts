/**
 * gameSim.ts
 *
 * The simulation container and tick driver. This is the port's one deliberate
 * architectural departure from the C++ (which uses static-class singletons):
 * all simulation state lives inside a `GameSim` instance, so many sims can
 * coexist — AI opponents, server-side verification, replays, and parallel tests.
 * The logic is unchanged; only ownership moves.
 *
 * `GameSim` owns the shared Clock and gameplay RNG and wires the subsystems
 * together. `step(actions)` advances exactly one 50 Hz tick, replicating the
 * gameplay portion of `Game::idlePlay` (Game.cxx:345) in its exact call order.
 * Wall-clock accumulation stays *outside* the sim: callers feed it whole ticks.
 *
 * STATUS — the tick driver and all gameplay physics are wired: Swapper, the
 * block and garbage `timeStep` state machines, Creep (rise/loss), the Grid
 * elimination detector, ComboManager, and GarbageGenerator each run at their
 * `Game::idlePlay` position. The remaining `TODO(shatter)` is the garbage
 * shatter *trigger* (Grid detection + awaking factories), ported next.
 *
 * Original work Copyright (C) 2000 Daniel Nelson, (C) 2004 Andrew Sayman.
 * GPL-2.0-or-later.
 */

import type { Block } from './block.js';
import { BlockManager } from './block.js';
import { generateInitialBoard, shiftBoardUp } from './board.js';
import { Clock } from './clock.js';
import { ComboManager } from './comboManager.js';
import { Creep, type CreepSimContext } from './creep.js';
import type { ComboTabulator } from './combo.js';
import type { ActionState } from './controller.js';
import type { Garbage } from './garbage.js';
import { GarbageManager } from './garbage.js';
import { GarbageGenerator } from './garbageGenerator.js';
import { GR_BLOCK, GR_EMPTY, Grid } from './grid.js';
import { Rng } from './rng.js';
import type { SignEvent, SignKind, SignSink } from './signs.js';
import { Swapper } from './swapper.js';
import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';

/**
 * Cap on undrained reward signs. Signs are cosmetic and normally drained every
 * frame; the cap just bounds memory for a headless run (tests, server, replay
 * harness) that never drains, keeping the newest events.
 */
const SIGN_BUFFER_CAP = 256;

export class GameSim implements CreepSimContext, SignSink {
  /** Shared tick counter (mirrors `Game::time_step`). */
  readonly clock = new Clock();
  /** The seed this sim was created with; `gameStart` reseeds from it. */
  private readonly seed: number;
  /** The single gameplay RNG stream. Draw order across subsystems is load-bearing. */
  readonly rng: Rng;
  /**
   * Separate, unsynced RNG for cosmetics (e.g. block death rotation axes). Kept
   * apart from the gameplay stream so cosmetic draws never perturb determinism,
   * per the port plan. Seeded off the game seed so a sim is still reproducible.
   */
  readonly cosmeticRng: Rng;

  readonly grid = new Grid();
  readonly blocks: BlockManager;
  readonly garbageStore: GarbageManager;
  readonly garbageGenerator: GarbageGenerator;
  readonly combos: ComboManager;
  /** The player's swap cursor. */
  readonly swapper = new Swapper();
  /** Board rise + loss state machine. */
  readonly creep = new Creep();

  /** True once Creep has detected a game loss. Mirrors solo `GS_END_PLAY`. */
  lost = false;

  /**
   * Count of blocks currently awaking. Gameplay-relevant: Creep does not rise
   * while any block is awaking or dying. Mirrors `Game::awaking_count`.
   */
  awaking_count = 0;
  /** Count of blocks currently dying. Mirrors `Game::dying_count`. */
  dying_count = 0;

  /** Cosmetic reward signs emitted since the last {@link drainSignEvents}. */
  private readonly signBuffer: SignEvent[] = [];

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.cosmeticRng = new Rng((this.seed ^ 0x9e3779b9) >>> 0);
    this.blocks = new BlockManager(this.grid, this.rng);
    this.garbageStore = new GarbageManager(this.grid, this.rng);
    this.garbageGenerator = new GarbageGenerator(this.clock, this.rng, this.garbageStore);
    this.garbageGenerator.signSink = this;
    this.combos = new ComboManager(this.clock, this.garbageGenerator);
    this.gameStart();
  }

  /**
   * Start a fresh game. Fans `gameStart` out to the subsystems, then generates
   * the initial board and the first creep row — mirroring the RNG draw order of
   * `Game::gameStart` → `Grid::gameStart` (board fill) → `Creep::gameStart`
   * (`BlockManager::newCreepRow`). All draws come from the one shared stream,
   * which is reseeded here, so calling `gameStart` again on an existing sim
   * (a rematch/restart) reproduces the same starting position as a fresh
   * `new GameSim(seed)`.
   */
  gameStart(): void {
    this.clock.time_step = 0;
    this.awaking_count = 0;
    this.dying_count = 0;
    this.lost = false;
    this.signBuffer.length = 0;

    // Reseed both RNGs so a restart is fully deterministic and does not depend
    // on draws made during the previous game.
    this.rng.setState(this.seed);
    this.cosmeticRng.setState((this.seed ^ 0x9e3779b9) >>> 0);

    // Reset subsystems first (stores, creep history, queues) so generation
    // starts from a clean, deterministic state.
    this.blocks.gameStart();
    this.garbageStore.gameStart();
    this.combos.gameStart();
    this.garbageGenerator.gameStart();
    this.grid.gameStart();
    this.swapper.gameStart();

    // RNG-driven starting position: board fill (Grid::gameStart), then the first
    // creep row (Creep::gameStart → BlockManager::newCreepRow). Draw order is
    // load-bearing, so Creep owns the first-row draw exactly as the C++ does.
    generateInitialBoard(this.grid, this.blocks);
    this.creep.gameStart(this);
  }

  /**
   * Advance one 50 Hz tick. Replicates the gameplay call order of
   * `Game::idlePlay` (Game.cxx:380-464). Meta/display/net/AI/X steps in the
   * original (LevelLights, MessageManager, Score, LoseBar, Communicator,
   * ComputerPlayer, X) are not part of the deterministic core and are omitted;
   * the physics steps are ported in follow-up phases.
   */
  step(actions: ActionState): void {
    // Game.cxx:383 — the tick counter advances at the top of a play step.
    this.clock.time_step++;

    // Game.cxx:386 — Swapper::timeStep(): continue/execute swaps and moves.
    this.swapper.timeStep(this, actions);

    // Game.cxx:399 — CountDownManager start-pause gate (intro countdown).
    // TODO(meta): start-pause gating

    // Game.cxx:415-423 — walk the grid bottom-to-top, stepping each resident.
    // Bottom-to-top so a block's support is stepped before the block itself.
    this.stepResidents();

    // Game.cxx:426 — Creep::timeStep(): rise, safe-height freeze, loss.
    this.creep.timeStep(this, actions);

    // Game.cxx:429 — Grid::timeStep(): drain elimination checks, detect
    // patterns, start dying, update top rows.
    this.grid.timeStep(this);

    // Game.cxx:432 — ComboManager::timeStep(): finish/emit combos.
    this.combos.timeStep();

    // Game.cxx:442 — GarbageGenerator::timeStep(): drop ready queued garbage.
    this.garbageGenerator.timeStep();

    // Game.cxx:453-459 — Clock/Score/LoseBar: display-layer, omitted from core.
  }

  /**
   * {@link SignSink}: record a cosmetic reward sign for the display layer. Called
   * by the combo/garbage code at the exact points `SignManager::createSign` fires
   * in the C++. Draws no gameplay RNG, so it never perturbs determinism; the
   * buffer is capped so an undrained headless run stays bounded (keeps the newest).
   */
  createSign(gridX: number, gridY: number, kind: SignKind, level: number): void {
    if (this.signBuffer.length >= SIGN_BUFFER_CAP) this.signBuffer.shift();
    this.signBuffer.push({ gridX, gridY, kind, level });
  }

  /** This sim as the cosmetic sign destination (`GridSimContext.signSink`). */
  get signSink(): SignSink {
    return this;
  }

  /**
   * Remove and return the reward signs emitted since the last drain. The display
   * layer calls this each frame to spawn floating sprites; a headless run can
   * ignore it (the buffer self-caps, and `gameStart` clears it).
   */
  drainSignEvents(): SignEvent[] {
    if (this.signBuffer.length === 0) return [];
    return this.signBuffer.splice(0, this.signBuffer.length);
  }

  /**
   * Step every grid resident, bottom-to-top. Mirrors the grid walk in
   * `Game::idlePlay` (Game.cxx:415-423). Row 0 (the creep row) is skipped, as in
   * the C++, so block reads of `y - 1` stay in bounds. Garbage advances the walk
   * cursor over its footprint (`Garbage.timeStep` returns the new `[x, y]`) — the
   * C++ passes the loop vars by reference. A full-width or 1-tall slab advances
   * both `x` and `y` so it runs exactly once; a tall, narrow slab only advances
   * `x`, so `timeStep` is invoked once per row it occupies but early-returns until
   * the walk reaches its top row, where it does the actual work.
   */
  private stepResidents(): void {
    let y = 1;
    while (y < GC_PLAY_HEIGHT) {
      let x = 0;
      while (x < GC_PLAY_WIDTH) {
        const rt = this.grid.residentTypeAt(x, y);
        if (rt & GR_EMPTY) {
          x++;
          continue;
        }
        if (rt & GR_BLOCK) {
          this.grid.blockAt(x, y).timeStep(this);
          x++;
        } else {
          // Garbage may advance both cursor coords (full-width slabs skip rows).
          const [nx, ny] = this.grid.garbageAt(x, y).timeStep(this, x, y);
          x = nx + 1;
          y = ny;
        }
      }
      y++;
    }
  }

  // --- BlockSimContext hooks -------------------------------------------------

  /** A block landed — let the Swapper fold it into an in-progress swap's combo. */
  notifyLanding(x: number, y: number, block: Block, combo: ComboTabulator): void {
    this.swapper.notifyLanding(x, y, block, combo);
  }

  /** A block/garbage fall reached a garbage slab below it — cascade the fall. */
  startGarbageFalling(garbage: Garbage, combo: ComboTabulator | null, noHang: boolean): void {
    garbage.startFalling(this, combo, noHang);
  }

  // --- CreepSimContext hooks -------------------------------------------------

  /**
   * Raise the whole board one row: grid array, block/garbage stores, and the
   * swap cursor. Mirrors `Grid::shiftGridUp` (Grid.cxx:339). Returns false when
   * the board can't rise (top row occupied).
   */
  shiftBoardUp(): boolean {
    return shiftBoardUp(this.grid, this.blocks, this.garbageStore, this.swapper);
  }

  /** Creep detected a loss. In solo play this simply ends the game. */
  notifyLoss(): void {
    this.lost = true;
  }
}

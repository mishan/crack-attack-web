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
 * STATUS — driver skeleton (Phase 1.6). Construction, `gameStart` wiring, the
 * input snapshot, and the tick order are in place, and the subsystems that are
 * already ported (ComboManager, GarbageGenerator) run each tick. The per-tick
 * *physics* — Swapper, the block/garbage `timeStep` state machines, Creep, and
 * the Grid elimination detector — are marked with `TODO(physics)` at their exact
 * positions in `step` and are ported subsystem-by-subsystem in follow-up steps,
 * each exercised through this driver.
 *
 * Original work Copyright (C) 2000 Daniel Nelson, (C) 2004 Andrew Sayman.
 * GPL-2.0-or-later.
 */

import type { Block } from './block.js';
import { BlockManager } from './block.js';
import { generateInitialBoard } from './board.js';
import { Clock } from './clock.js';
import { ComboManager } from './comboManager.js';
import type { ComboTabulator } from './combo.js';
import type { ActionState } from './controller.js';
import type { Garbage } from './garbage.js';
import { GarbageManager } from './garbage.js';
import { GarbageGenerator } from './garbageGenerator.js';
import { GR_BLOCK, GR_EMPTY, Grid, type GridSimContext } from './grid.js';
import { Rng } from './rng.js';
import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';

export class GameSim implements GridSimContext {
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

  /**
   * Count of blocks currently awaking. Gameplay-relevant: Creep does not rise
   * while any block is awaking or dying. Mirrors `Game::awaking_count`.
   */
  awaking_count = 0;
  /** Count of blocks currently dying. Mirrors `Game::dying_count`. */
  dying_count = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.cosmeticRng = new Rng((this.seed ^ 0x9e3779b9) >>> 0);
    this.blocks = new BlockManager(this.grid, this.rng);
    this.garbageStore = new GarbageManager(this.grid, this.rng);
    this.garbageGenerator = new GarbageGenerator(this.clock, this.rng, this.garbageStore);
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

    // RNG-driven starting position: board fill, then the first creep row.
    generateInitialBoard(this.grid, this.blocks);
    this.blocks.newCreepRow();
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

    // Reference `actions` so the input contract is explicit; the systems that
    // consume it (Swapper, Creep) are ported next.
    void actions;

    // Game.cxx:386 — Swapper::timeStep(): continue/execute swaps and moves.
    // TODO(physics): this.swapper.timeStep(actions)

    // Game.cxx:399 — CountDownManager start-pause gate (intro countdown).
    // TODO(meta): start-pause gating

    // Game.cxx:415-423 — walk the grid bottom-to-top, stepping each resident.
    // Bottom-to-top so a block's support is stepped before the block itself.
    this.stepResidents();

    // Game.cxx:426 — Creep::timeStep(actions): rise, safe-height freeze, loss.
    // TODO(physics): this.creep.timeStep(actions)

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
   * Step every grid resident, bottom-to-top. Mirrors the grid walk in
   * `Game::idlePlay` (Game.cxx:415-423). Row 0 (the creep row) is skipped, as in
   * the C++, so block reads of `y - 1` stay in bounds. Garbage stepping is a
   * TODO until Garbage physics lands.
   */
  private stepResidents(): void {
    for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH; x++) {
        const rt = this.grid.residentTypeAt(x, y);
        if (rt & GR_EMPTY) continue;
        if (rt & GR_BLOCK) {
          this.grid.blockAt(x, y).timeStep(this);
        }
        // else GR_GARBAGE — TODO(physics): this.grid.garbageAt(x, y).timeStep(x, y)
      }
    }
  }

  // --- BlockSimContext hooks -------------------------------------------------
  // Bridges to subsystems not yet ported; no-ops for now (documented TODOs).

  /** Swapper landing notification. No-op until the Swapper is ported. */
  notifyLanding(_x: number, _y: number, _block: Block, _combo: ComboTabulator): void {
    // TODO(Swapper): switch a swapping block's combo on landing (Swapper::notifyLanding).
  }

  /** Start a garbage slab falling. No-op until Garbage physics is ported. */
  startGarbageFalling(_garbage: Garbage, _combo: ComboTabulator | null, _noHang: boolean): void {
    // TODO(Garbage physics): Garbage::startFalling — cascade a fall into garbage above.
  }
}

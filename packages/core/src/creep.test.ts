import { describe, expect, it } from 'vitest';
import { BlockManager } from './block.js';
import { shiftBoardUp } from './board.js';
import { Clock } from './clock.js';
import { ComboManager } from './comboManager.js';
import { GC_LOSS_DELAY, GC_LOSS_DELAY_ELIMINATION, GC_SAFE_HEIGHT } from './constants.js';
import { ActionState, CC_ADVANCE, noActions } from './controller.js';
import { Creep, type CreepSimContext } from './creep.js';
import { GameSim } from './gameSim.js';
import { GarbageGenerator } from './garbageGenerator.js';
import { GarbageManager } from './garbage.js';
import { Grid } from './grid.js';
import { Rng } from './rng.js';
import { Swapper } from './swapper.js';

/**
 * Minimal CreepSimContext for driving Creep in isolation. The freeze/loss tests
 * set `grid.top_effective_row` directly to control the safe-height check without
 * building a real stack.
 */
class CreepCtx implements CreepSimContext {
  readonly grid = new Grid();
  readonly clock = new Clock();
  readonly rng = new Rng(1);
  readonly cosmeticRng = new Rng(2);
  readonly blocks: BlockManager;
  readonly garbageStore: GarbageManager;
  readonly garbageGenerator: GarbageGenerator;
  readonly combos: ComboManager;
  readonly swapper = new Swapper();
  awaking_count = 0;
  dying_count = 0;
  lost = false;

  constructor() {
    this.blocks = new BlockManager(this.grid, this.rng);
    this.garbageStore = new GarbageManager(this.grid, this.rng);
    this.garbageGenerator = new GarbageGenerator(this.clock, this.rng, this.garbageStore);
    this.combos = new ComboManager(this.clock, this.garbageGenerator);
  }

  shiftBoardUp(): boolean {
    return shiftBoardUp(this.grid, this.blocks, this.garbageStore, this.swapper);
  }
  notifyLoss(): void {
    this.lost = true;
  }
  notifyLanding(): void {}
  startGarbageFalling(): void {}
}

/** Drive one creep tick (advancing the clock first, as GameSim.step does). */
const tick = (ctx: CreepCtx, creep: Creep, action: ActionState): void => {
  ctx.clock.time_step++;
  creep.timeStep(ctx, action);
};

describe('Creep safe-height freeze and loss', () => {
  it('freezes at the safe height and starts the loss countdown', () => {
    const ctx = new CreepCtx();
    ctx.grid.top_effective_row = GC_SAFE_HEIGHT - 1; // a violation
    const creep = new Creep();

    tick(ctx, creep, noActions());

    expect(creep.creep_freeze).toBe(true);
    expect(creep.loss_alarm).toBe(GC_LOSS_DELAY);
    expect(ctx.lost).toBe(false);
  });

  it('loses once the loss countdown runs out while still violating', () => {
    const ctx = new CreepCtx();
    ctx.grid.top_effective_row = GC_SAFE_HEIGHT - 1;
    const creep = new Creep();

    for (let i = 0; i < GC_LOSS_DELAY + 5 && !ctx.lost; i++) tick(ctx, creep, noActions());

    expect(ctx.lost).toBe(true);
  });

  it('clears the freeze when the stack drops back below the safe height', () => {
    const ctx = new CreepCtx();
    ctx.grid.top_effective_row = GC_SAFE_HEIGHT - 1;
    const creep = new Creep();
    tick(ctx, creep, noActions());
    expect(creep.creep_freeze).toBe(true);

    // eliminate back down below the safe height
    ctx.grid.top_effective_row = GC_SAFE_HEIGHT - 3;
    tick(ctx, creep, noActions());

    expect(creep.creep_freeze).toBe(false);
    expect(ctx.lost).toBe(false);
  });

  it('does not lose while blocks are dying, even past the loss delay', () => {
    const ctx = new CreepCtx();
    ctx.grid.top_effective_row = GC_SAFE_HEIGHT - 1;
    const creep = new Creep();
    tick(ctx, creep, noActions()); // enter the freeze

    ctx.dying_count = 1; // an elimination is in progress
    for (let i = 0; i < GC_LOSS_DELAY + 5; i++) tick(ctx, creep, noActions());

    expect(ctx.lost).toBe(false);
    // the loss alarm can't drop below the post-elimination grace period
    expect(creep.loss_alarm).toBeGreaterThanOrEqual(GC_LOSS_DELAY_ELIMINATION);
  });
});

describe('Creep board rise', () => {
  it('raises the board and adds a creep row when advance is held', () => {
    const sim = new GameSim(1);
    const blocksBefore = sim.blocks.block_count;
    const swapperYBefore = sim.swapper.y;

    // Advance floods the creep timer; a full grid (60 units at +3/tick) rises in
    // ~20 ticks. Run enough ticks for at least one rise.
    for (let i = 0; i < 30; i++) sim.step(new ActionState(CC_ADVANCE));

    // Each rise appends a fresh 6-wide creep row and rides the cursor up.
    expect(sim.blocks.block_count).toBeGreaterThan(blocksBefore);
    expect(sim.swapper.y).toBeGreaterThan(swapperYBefore);
    expect(sim.lost).toBe(false);
  });

  it('creeps slowly with no input (no rise over a handful of ticks)', () => {
    const sim = new GameSim(1);
    const swapperYBefore = sim.swapper.y;

    for (let i = 0; i < 10; i++) sim.step(noActions());

    // Base creep speed is 20/tick vs a 1200 grid delay, so nothing rises yet.
    expect(sim.swapper.y).toBe(swapperYBefore);
    expect(sim.creep.creep).toBe(0);
  });
});

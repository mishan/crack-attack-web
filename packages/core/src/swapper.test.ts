import { describe, expect, it } from 'vitest';
import {
  BF_NORMAL_1,
  BF_NORMAL_2,
  BF_NORMAL_5,
  GC_DYING_DELAY,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
} from './constants.js';
import type { Block } from './block.js';
import { BlockManager } from './block.js';
import { Clock } from './clock.js';
import type { ComboTabulator } from './combo.js';
import { ComboManager } from './comboManager.js';
import { ActionState, CC_RIGHT, CC_SWAP, noActions } from './controller.js';
import { GameSim } from './gameSim.js';
import { GarbageGenerator } from './garbageGenerator.js';
import { GarbageManager } from './garbage.js';
import { GR_BLOCK, GR_EMPTY, Grid, type GridSimContext } from './grid.js';
import { Rng } from './rng.js';
import { SS_MOVE_PAUSE, SS_SWAPPING, Swapper } from './swapper.js';

// --- cursor movement (through the full GameSim) ----------------------------

describe('Swapper cursor movement', () => {
  it('moves right on a press', () => {
    const sim = new GameSim(1);
    const x0 = sim.swapper.x;
    sim.step(new ActionState(CC_RIGHT));
    expect(sim.swapper.x).toBe(x0 + 1);
  });

  it('respects the right edge (x max is GC_PLAY_WIDTH - 2)', () => {
    const sim = new GameSim(1);
    const moveRight = (): void => {
      // wait out any move-pause (bounded so a stuck pause fails, not hangs)
      let guard = 0;
      while (sim.swapper.state & SS_MOVE_PAUSE) {
        sim.step(noActions());
        expect(++guard).toBeLessThan(100);
      }
      sim.step(new ActionState(CC_RIGHT));
    };
    for (let i = 0; i < 10; i++) moveRight();
    expect(sim.swapper.x).toBe(GC_PLAY_WIDTH - 2); // clamps at the right edge
  });

  it('does nothing under neutral input', () => {
    const sim = new GameSim(1);
    const x0 = sim.swapper.x;
    const y0 = sim.swapper.y;
    for (let i = 0; i < 5; i++) sim.step(noActions());
    expect(sim.swapper.x).toBe(x0);
    expect(sim.swapper.y).toBe(y0);
  });
});

// --- swap execution (through a controlled context) -------------------------

class Ctx implements GridSimContext {
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

  constructor() {
    this.blocks = new BlockManager(this.grid, this.rng);
    this.garbageStore = new GarbageManager(this.grid, this.rng);
    this.garbageGenerator = new GarbageGenerator(this.clock, this.rng, this.garbageStore);
    this.combos = new ComboManager(this.clock, this.garbageGenerator);
  }

  notifyLanding(x: number, y: number, block: Block, combo: ComboTabulator): void {
    this.swapper.notifyLanding(x, y, block, combo);
  }
  startGarbageFalling(): void {}
}

/** One tick in GameSim.step order, driving the swapper with `action`. */
const tick = (ctx: Ctx, action: ActionState): void => {
  ctx.clock.time_step++;
  ctx.swapper.timeStep(ctx, action);
  for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      if (ctx.grid.residentTypeAt(x, y) & GR_BLOCK) ctx.grid.blockAt(x, y).timeStep(ctx);
    }
  }
  ctx.grid.timeStep(ctx);
  ctx.combos.timeStep();
  ctx.garbageGenerator.timeStep();
};

describe('Swapper swap execution', () => {
  it('moves a block into an empty neighbour', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_5); // floor under both cells so the
    ctx.blocks.newBlock(1, 0, BF_NORMAL_5); // swapped block stays supported
    ctx.blocks.newBlock(0, 1, BF_NORMAL_1); // block to swap right into (1,1)
    const block = ctx.grid.blockAt(0, 1);
    ctx.swapper.x = 0;
    ctx.swapper.y = 1;

    tick(ctx, new ActionState(CC_SWAP)); // initiate
    expect(ctx.swapper.state & SS_SWAPPING).toBeTruthy();
    // step until the swap finishes rather than hard-coding GC_SWAP_DELAY
    for (let i = 0; i < 60 && ctx.swapper.state & SS_SWAPPING; i++) tick(ctx, noActions());

    expect(ctx.grid.stateAt(0, 1)).toBe(GR_EMPTY);
    expect(ctx.grid.blockAt(1, 1)).toBe(block);
    expect(block.x).toBe(1);
  });

  it('a swap that forms a run of three eliminates it', () => {
    const ctx = new Ctx();
    // floor row (distinct flavor; row 0 is never part of a pattern)
    for (let x = 0; x < 4; x++) ctx.blocks.newBlock(x, 0, BF_NORMAL_5);
    // A A B A  — swapping the B(2) and A(3) makes A A A B
    ctx.blocks.newBlock(0, 1, BF_NORMAL_1);
    ctx.blocks.newBlock(1, 1, BF_NORMAL_1);
    ctx.blocks.newBlock(2, 1, BF_NORMAL_2);
    ctx.blocks.newBlock(3, 1, BF_NORMAL_1);
    ctx.swapper.x = 2;
    ctx.swapper.y = 1;

    tick(ctx, new ActionState(CC_SWAP));
    // run until the swap completes and the match is detected
    let detected = false;
    for (let i = 0; i < 20 && !detected; i++) {
      tick(ctx, noActions());
      if (ctx.dying_count > 0) detected = true;
    }
    expect(ctx.dying_count).toBe(3);

    // let the dying countdown finish; the three A's are removed
    for (let i = 0; i < GC_DYING_DELAY + 2; i++) tick(ctx, noActions());
    expect(ctx.grid.stateAt(0, 1)).toBe(GR_EMPTY);
    expect(ctx.grid.stateAt(1, 1)).toBe(GR_EMPTY);
    expect(ctx.grid.stateAt(2, 1)).toBe(GR_EMPTY);
    expect(ctx.dying_count).toBe(0);
  });

  it('does not start a swap over two empty cells', () => {
    const ctx = new Ctx();
    ctx.swapper.x = 2;
    ctx.swapper.y = 1;
    tick(ctx, new ActionState(CC_SWAP));
    expect(ctx.swapper.state & SS_SWAPPING).toBe(0);
  });
});

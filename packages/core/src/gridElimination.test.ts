import { describe, expect, it } from 'vitest';
import {
  BF_NORMAL_1,
  BF_NORMAL_2,
  GC_DYING_DELAY,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
} from './constants.js';
import type { Block } from './block.js';
import { BS_DYING, BlockManager } from './block.js';
import { Clock } from './clock.js';
import type { ComboTabulator } from './combo.js';
import type { Garbage } from './garbage.js';
import { ComboManager } from './comboManager.js';
import { GarbageGenerator } from './garbageGenerator.js';
import { GarbageManager } from './garbage.js';
import { GR_BLOCK, GR_EMPTY, Grid, type GridSimContext } from './grid.js';
import { Rng } from './rng.js';

/** A full elimination-capable context (grid + blocks + combos + garbage). */
class Ctx implements GridSimContext {
  readonly grid = new Grid();
  readonly clock = new Clock();
  readonly rng = new Rng(1);
  readonly cosmeticRng = new Rng(2);
  readonly blocks: BlockManager;
  readonly garbageStore: GarbageManager;
  readonly garbageGenerator: GarbageGenerator;
  readonly combos: ComboManager;
  awaking_count = 0;
  dying_count = 0;

  constructor() {
    this.blocks = new BlockManager(this.grid, this.rng);
    this.garbageStore = new GarbageManager(this.grid, this.rng);
    this.garbageGenerator = new GarbageGenerator(this.clock, this.rng, this.garbageStore);
    this.combos = new ComboManager(this.clock, this.garbageGenerator);
  }

  notifyLanding(_x: number, _y: number, _block: Block, _combo: ComboTabulator): void {}
  startGarbageFalling(_garbage: Garbage, _combo: ComboTabulator | null, _noHang: boolean): void {}
}

/** Place a static block and mark it for an elimination check. */
const place = (ctx: Ctx, x: number, y: number, flavor: number): void => {
  ctx.blocks.newBlock(x, y, flavor);
  ctx.grid.requestEliminationCheck(ctx.grid.blockAt(x, y));
};

/** One grid tick (drain checks + recompute top rows). */
const gridTick = (ctx: Ctx): void => {
  ctx.clock.time_step++;
  ctx.grid.timeStep(ctx);
};

describe('Grid elimination — horizontal', () => {
  it('detects a run of three and starts them all dying', () => {
    const ctx = new Ctx();
    place(ctx, 1, 1, BF_NORMAL_1);
    place(ctx, 2, 1, BF_NORMAL_1);
    place(ctx, 3, 1, BF_NORMAL_1);

    gridTick(ctx);

    expect(ctx.dying_count).toBe(3);
    for (const x of [1, 2, 3]) expect(ctx.grid.blockAt(x, 1).state).toBe(BS_DYING);
  });

  it('does not fire on a run of only two', () => {
    const ctx = new Ctx();
    place(ctx, 1, 1, BF_NORMAL_1);
    place(ctx, 2, 1, BF_NORMAL_1);

    gridTick(ctx);

    expect(ctx.dying_count).toBe(0);
    expect(ctx.grid.blockAt(1, 1).state).not.toBe(BS_DYING);
  });

  it('does not match across different flavors', () => {
    const ctx = new Ctx();
    place(ctx, 1, 1, BF_NORMAL_1);
    place(ctx, 2, 1, BF_NORMAL_2);
    place(ctx, 3, 1, BF_NORMAL_1);

    gridTick(ctx);
    expect(ctx.dying_count).toBe(0);
  });
});

describe('Grid elimination — score snapshot', () => {
  it('emits a combo score snapshot at the reporting tick', () => {
    const ctx = new Ctx();
    const captured: { magnitude: number; multiplier: number; special: readonly number[] }[] = [];
    ctx.combos.scoreSink = { reportComboElimination: (e) => captured.push(e) };

    place(ctx, 1, 1, BF_NORMAL_1);
    place(ctx, 2, 1, BF_NORMAL_1);
    place(ctx, 3, 1, BF_NORMAL_1);

    gridTick(ctx); // detector reports the elimination onto a fresh combo
    ctx.combos.timeStep(); // ComboManager sees time_stamp === now → emits

    expect(captured).toHaveLength(1);
    expect(captured[0]!.magnitude).toBe(3);
    expect(captured[0]!.multiplier).toBe(1); // no chain
    expect(captured[0]!.special.every((n) => n === 0)).toBe(true);
  });
});

describe('Grid elimination — vertical', () => {
  it('detects a vertical run of three', () => {
    const ctx = new Ctx();
    // A vertical triple in column 0 (rows 1-3). This unit test only drives the
    // detector (gridTick), not block physics, so the blocks are left static and
    // no supporting floor is needed.
    place(ctx, 0, 1, BF_NORMAL_1);
    place(ctx, 0, 2, BF_NORMAL_1);
    place(ctx, 0, 3, BF_NORMAL_1);

    gridTick(ctx);

    expect(ctx.dying_count).toBe(3);
    for (const y of [1, 2, 3]) expect(ctx.grid.blockAt(0, y).state).toBe(BS_DYING);
  });
});

describe('Grid elimination — combined shape', () => {
  it('an L of five (3 across, 3 up sharing a corner) dies as five blocks', () => {
    const ctx = new Ctx();
    // corner at (1,1); arm right to (3,1); arm up to (1,3)
    place(ctx, 1, 1, BF_NORMAL_1);
    place(ctx, 2, 1, BF_NORMAL_1);
    place(ctx, 3, 1, BF_NORMAL_1);
    place(ctx, 1, 2, BF_NORMAL_1);
    place(ctx, 1, 3, BF_NORMAL_1);

    gridTick(ctx);

    // 3 + 3 sharing the corner = 5 distinct blocks, all dying
    expect(ctx.dying_count).toBe(5);
    expect(ctx.combos.comboCount).toBe(1);
  });
});

describe('Grid elimination — lifecycle', () => {
  it('dying blocks are removed after the dying delay', () => {
    const ctx = new Ctx();
    place(ctx, 1, 1, BF_NORMAL_1);
    place(ctx, 2, 1, BF_NORMAL_1);
    place(ctx, 3, 1, BF_NORMAL_1);

    gridTick(ctx); // detect -> start dying

    // run the dying countdown by stepping the blocks each tick
    for (let i = 0; i < GC_DYING_DELAY; i++) {
      ctx.clock.time_step++;
      for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
        for (let x = 0; x < GC_PLAY_WIDTH; x++) {
          if (ctx.grid.residentTypeAt(x, y) & GR_BLOCK) ctx.grid.blockAt(x, y).timeStep(ctx);
        }
      }
      ctx.grid.timeStep(ctx);
    }

    expect(ctx.dying_count).toBe(0);
    for (const x of [1, 2, 3]) expect(ctx.grid.stateAt(x, 1)).toBe(GR_EMPTY);
    expect(ctx.blocks.block_count).toBe(0);
  });

  it('no pending checks means no combo is created', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(1, 1, BF_NORMAL_1); // placed but not requested
    gridTick(ctx);
    expect(ctx.combos.comboCount).toBe(0);
    expect(ctx.dying_count).toBe(0);
  });
});

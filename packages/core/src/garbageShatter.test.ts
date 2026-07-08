import { describe, expect, it } from 'vitest';
import { BF_NORMAL_1, GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';
import type { Block } from './block.js';
import { BlockManager } from './block.js';
import { Clock } from './clock.js';
import type { ComboTabulator } from './combo.js';
import { ComboManager } from './comboManager.js';
import { GF_NORMAL, GF_SHATTER_TO_NORMAL_GARBAGE } from './flavors.js';
import { GarbageGenerator } from './garbageGenerator.js';
import { type Garbage, GarbageManager, GS_STATIC } from './garbage.js';
import { GR_BLOCK, GR_EMPTY, GR_GARBAGE, GR_IMMUTABLE, Grid, type GridSimContext } from './grid.js';
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
  startGarbageFalling(garbage: Garbage, combo: ComboTabulator | null, noHang: boolean): void {
    garbage.startFalling(this, combo, noHang);
  }
}

/** Resident walk (one tick), mirroring GameSim.stepResidents. */
const walk = (ctx: Ctx): void => {
  ctx.clock.time_step++;
  let y = 1;
  while (y < GC_PLAY_HEIGHT) {
    let x = 0;
    while (x < GC_PLAY_WIDTH) {
      const rt = ctx.grid.residentTypeAt(x, y);
      if (rt & GR_EMPTY) {
        x++;
        continue;
      }
      if (rt & GR_BLOCK) {
        ctx.grid.blockAt(x, y).timeStep(ctx);
        x++;
      } else {
        const [nx, ny] = ctx.grid.garbageAt(x, y).timeStep(ctx, x, y);
        x = nx + 1;
        y = ny;
      }
    }
    y++;
  }
};

/** Full-width floor of resting blocks at row 0 (never stepped). */
const floor = (ctx: Ctx): void => {
  for (let x = 0; x < GC_PLAY_WIDTH; x++) ctx.blocks.newBlock(x, 0, BF_NORMAL_1);
};

/** Drop a slab and step until it lands (GS_STATIC), returning it. */
const landGarbage = (
  ctx: Ctx,
  x: number,
  y: number,
  height: number,
  width: number,
  flavor: number,
): Garbage => {
  ctx.garbageStore.newFallingGarbageAt(x, y, height, width, flavor, ctx.clock.time_step);
  const g = ctx.grid.garbageAt(x, y);
  for (let i = 0; i < 60 && g.state !== GS_STATIC; i++) walk(ctx);
  return g;
};

describe('Garbage shattering', () => {
  it('an adjacent elimination shatters a garbage slab into awaking blocks', () => {
    const ctx = new Ctx();
    floor(ctx);
    // a 2-wide static slab resting on the floor at columns 0-1, row 1
    const g = landGarbage(ctx, 0, 5, 1, 2, GF_NORMAL);
    expect(g.y).toBe(1);

    // a vertical run of three in column 2 (rows 1-3), touching the slab's right
    for (const y of [1, 2, 3]) ctx.blocks.newBlock(2, y, BF_NORMAL_1);
    ctx.grid.requestEliminationCheck(ctx.grid.blockAt(2, 2));

    ctx.clock.time_step++;
    ctx.grid.timeStep(ctx);

    // the three blocks die; the touching slab shatters into two awaking blocks
    expect(ctx.dying_count).toBe(3);
    expect(ctx.awaking_count).toBe(2);
    expect(ctx.garbageStore.garbage_count).toBe(0); // slab returned to the pool
    for (const x of [0, 1]) {
      expect(ctx.grid.residentTypeAt(x, 1) & GR_BLOCK).toBeTruthy();
      expect(ctx.grid.stateAt(x, 1)).toBe(GR_IMMUTABLE); // awaking
    }
  });

  it('a shatter-to-garbage slab re-forms as an awaking garbage row', () => {
    const ctx = new Ctx();
    floor(ctx);
    // full row of matching blocks at row 1 (the run + support for the slab above)
    for (let x = 0; x < GC_PLAY_WIDTH; x++) ctx.blocks.newBlock(x, 1, BF_NORMAL_1);
    // a full-width shatter-to-garbage slab landing on that row, at row 2
    const g = landGarbage(ctx, 0, 6, 1, GC_PLAY_WIDTH, GF_SHATTER_TO_NORMAL_GARBAGE);
    expect(g.y).toBe(2);

    // eliminate the row-1 blocks beneath it
    ctx.grid.requestEliminationCheck(ctx.grid.blockAt(0, 1));
    ctx.clock.time_step++;
    ctx.grid.timeStep(ctx);

    expect(ctx.dying_count).toBe(GC_PLAY_WIDTH);
    // one fresh full-width awaking garbage replaces the shattered slab
    expect(ctx.awaking_count).toBe(1);
    expect(ctx.garbageStore.garbage_count).toBe(1);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      expect(ctx.grid.residentTypeAt(x, 2)).toBe(GR_GARBAGE);
      expect(ctx.grid.stateAt(x, 2)).toBe(GR_IMMUTABLE); // awaking
    }
  });
});

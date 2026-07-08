import { describe, expect, it } from 'vitest';
import { BF_NORMAL_1, GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';
import { BS_STATIC, Block, BlockManager, type BlockSimContext } from './block.js';
import { Clock } from './clock.js';
import type { ComboTabulator } from './combo.js';
import { GF_NORMAL } from './flavors.js';
import { type Garbage, GarbageManager, GS_FALLING, GS_STATIC } from './garbage.js';
import { GR_BLOCK, GR_EMPTY, GR_GARBAGE, Grid } from './grid.js';
import { Rng } from './rng.js';

/** A minimal BlockSimContext that also owns a garbage store, for physics tests. */
class Ctx implements BlockSimContext {
  readonly grid = new Grid();
  readonly clock = new Clock();
  readonly blocks: BlockManager;
  readonly garbageStore: GarbageManager;
  awaking_count = 0;
  dying_count = 0;
  readonly cosmeticRng = new Rng(1);

  constructor() {
    const rng = new Rng(1);
    this.blocks = new BlockManager(this.grid, rng);
    this.garbageStore = new GarbageManager(this.grid, rng);
  }

  notifyLanding(_x: number, _y: number, _block: Block, _combo: ComboTabulator): void {}
  startGarbageFalling(garbage: Garbage, combo: ComboTabulator | null, noHang: boolean): void {
    garbage.startFalling(this, combo, noHang);
  }
}

/** Full-width floor of resting blocks at row 0 (never stepped). */
const floor = (ctx: Ctx): void => {
  for (let x = 0; x < GC_PLAY_WIDTH; x++) ctx.blocks.newBlock(x, 0, BF_NORMAL_1);
};

/** One tick: bottom-to-top resident walk, mirroring GameSim.stepResidents. */
const tick = (ctx: Ctx): void => {
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

describe('Garbage falling', () => {
  it('a falling slab drops and lands on the floor', () => {
    const ctx = new Ctx();
    floor(ctx);
    // full-width, 2-tall slab floating at y = 5
    ctx.garbageStore.newFallingGarbageAt(0, 5, 2, GC_PLAY_WIDTH, GF_NORMAL, ctx.clock.time_step);
    const g = ctx.grid.garbageAt(0, 5);
    expect(g.state).toBe(GS_FALLING);

    for (let i = 0; i < 40 && g.state !== GS_STATIC; i++) tick(ctx);

    expect(g.state).toBe(GS_STATIC);
    expect(g.y).toBe(1); // resting on the row-0 floor
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      expect(ctx.grid.stateAt(x, 1)).toBe(GR_GARBAGE);
      expect(ctx.grid.stateAt(x, 2)).toBe(GR_GARBAGE);
    }
  });

  it('raises top_effective_row when an initial fall lands (notifyImpact)', () => {
    const ctx = new Ctx();
    floor(ctx);
    ctx.garbageStore.newFallingGarbageAt(0, 6, 2, GC_PLAY_WIDTH, GF_NORMAL, ctx.clock.time_step);
    const g = ctx.grid.garbageAt(0, 6);
    expect(ctx.grid.top_effective_row).toBe(0); // a falling slab doesn't count yet

    for (let i = 0; i < 40 && g.state !== GS_STATIC; i++) tick(ctx);

    // landed at y = 1, height 2 → impact top = 2
    expect(g.y).toBe(1);
    expect(ctx.grid.top_effective_row).toBe(2);
  });

  it('a static slab and the block on top fall together when support is pulled', () => {
    const ctx = new Ctx();
    floor(ctx);
    // removable support row of blocks at row 1 (held up by the row-0 floor)
    for (let x = 0; x < GC_PLAY_WIDTH; x++) ctx.blocks.newBlock(x, 1, BF_NORMAL_1);
    // 1-tall full-width slab lands on that support at y = 2
    ctx.garbageStore.newFallingGarbageAt(0, 7, 1, GC_PLAY_WIDTH, GF_NORMAL, ctx.clock.time_step);
    const g = ctx.grid.garbageAt(0, 7);
    for (let i = 0; i < 40 && g.state !== GS_STATIC; i++) tick(ctx);
    expect(g.y).toBe(2);
    // a block resting on top of the slab
    ctx.blocks.newBlock(0, 3, BF_NORMAL_1);
    const rider = ctx.grid.blockAt(0, 3);
    expect(rider.state).toBe(BS_STATIC);

    // pull the support out from under the slab
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      const b = ctx.grid.blockAt(x, 1);
      ctx.grid.remove(x, 1, b);
      ctx.blocks.deleteBlock(b);
    }

    // the slab falls, cascading the fall up into the rider block; step enough
    // ticks for both (the slab lands first, the rider a few ticks later)
    for (let i = 0; i < 40; i++) tick(ctx);
    expect(g.y).toBe(1); // slab settled on the floor
    expect(rider.state).toBe(BS_STATIC); // rider re-landed on top of the slab
    expect(rider.y).toBe(2);
  });
});

describe('Garbage awaking', () => {
  it('counts toward awaking_count and settles to static when the alarm fires', () => {
    const ctx = new Ctx();
    floor(ctx);
    const g = ctx.garbageStore.garbage(0);
    // awaking garbage is always full width; sits on the floor at y = 1
    g.initializeAwaking(0, 1, 1, 1, 5, null, 0, ctx);
    expect(ctx.awaking_count).toBe(1);

    for (let i = 0; i < 6; i++) tick(ctx);

    expect(g.state).toBe(GS_STATIC);
    expect(ctx.awaking_count).toBe(0);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) expect(ctx.grid.stateAt(x, 1)).toBe(GR_GARBAGE);
  });
});

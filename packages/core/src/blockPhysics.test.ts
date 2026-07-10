import { describe, expect, it } from 'vitest';
import {
  BF_NORMAL_1,
  BF_NORMAL_2,
  GC_DYING_DELAY,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
} from './constants.js';
import {
  BS_AWAKING,
  BS_DYING,
  BS_FALLING,
  BS_STATIC,
  BS_SWAPPING,
  BS_SWAP_DIRECTION_MASK,
  Block,
  BlockManager,
  SA_LEFT,
  SA_RIGHT,
  type BlockSimContext,
} from './block.js';
import { Clock } from './clock.js';
import { ComboTabulator } from './combo.js';
import type { Garbage } from './garbage.js';
import { GR_BLOCK, GR_EMPTY, GR_IMMUTABLE, Grid } from './grid.js';
import { Rng } from './rng.js';

/** A minimal BlockSimContext for isolated physics tests. */
class Ctx implements BlockSimContext {
  readonly grid = new Grid();
  readonly clock = new Clock();
  readonly blocks: BlockManager;
  awaking_count = 0;
  dying_count = 0;
  readonly cosmeticRng = new Rng(1);
  landingCalls = 0;
  garbageFallCalls = 0;
  readonly sounds: { sound: string; volume: number }[] = [];

  constructor() {
    this.blocks = new BlockManager(this.grid, new Rng(1));
  }

  notifyLanding(_x: number, _y: number, _block: Block, _combo: ComboTabulator): void {
    this.landingCalls++;
  }
  startGarbageFalling(_garbage: Garbage, _combo: ComboTabulator | null, _noHang: boolean): void {
    this.garbageFallCalls++;
  }
  notifyCosmeticSound(sound: string, volume: number): void {
    this.sounds.push({ sound, volume });
  }
}

/** Advance one tick: bottom-to-top block walk, mirroring GameSim.stepResidents. */
const tick = (ctx: Ctx): void => {
  ctx.clock.time_step++;
  for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      if (ctx.grid.residentTypeAt(x, y) & GR_BLOCK) ctx.grid.blockAt(x, y).timeStep(ctx);
    }
  }
};

describe('Block falling', () => {
  it('a supported block stays put', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_1); // floor (row 0, never stepped)
    ctx.blocks.newBlock(0, 1, BF_NORMAL_2);
    const b = ctx.grid.blockAt(0, 1);
    tick(ctx);
    expect(b.state).toBe(BS_STATIC);
    expect(b.y).toBe(1);
  });

  it('an unsupported block hangs, falls, and lands on the floor', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_1); // floor
    ctx.blocks.newBlock(0, 5, BF_NORMAL_2); // floating
    const b = ctx.grid.blockAt(0, 5);

    tick(ctx); // begins falling (hang)
    expect(b.state & BS_FALLING).toBeTruthy();

    for (let i = 0; i < 60; i++) tick(ctx);

    expect(b.state).toBe(BS_STATIC);
    expect(b.y).toBe(1); // rests directly on the floor
    expect(ctx.grid.blockAt(0, 1)).toBe(b);
    expect(ctx.grid.stateAt(0, 5)).toBe(GR_EMPTY);
    // Landing fires the block_fallen cue exactly once (Block.cxx:168, vol 2).
    expect(ctx.sounds).toEqual([{ sound: 'block_fallen', volume: 2 }]);
  });

  it('registers an elimination check when it lands', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_1);
    ctx.blocks.newBlock(0, 5, BF_NORMAL_2);
    for (let i = 0; i < 61; i++) tick(ctx);
    expect(ctx.grid.checkCount).toBeGreaterThanOrEqual(1);
  });

  it('a block falls through a gap and settles on the stack', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_1); // floor
    ctx.blocks.newBlock(0, 1, BF_NORMAL_2); // supported, stays
    ctx.blocks.newBlock(0, 3, BF_NORMAL_1); // above a gap at y=2
    const supported = ctx.grid.blockAt(0, 1);
    const top = ctx.grid.blockAt(0, 3);

    for (let i = 0; i < 60; i++) tick(ctx);

    expect(supported.y).toBe(1);
    expect(top.y).toBe(2); // fell into the gap, rests on the supported block
    expect(ctx.grid.blockAt(0, 2)).toBe(top);
    expect(ctx.grid.stateAt(0, 3)).toBe(GR_EMPTY);
  });
});

describe('Block dying', () => {
  it('counts down, removes the block, and releases the combo', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_1); // floor
    ctx.blocks.newBlock(0, 1, BF_NORMAL_2); // will die
    const dying = ctx.grid.blockAt(0, 1);
    const id = dying.id;

    const combo = new ComboTabulator();
    combo.initialize(0);
    dying.startDying(ctx, combo, 5);

    // startDying fires the block_dying cue at volume spark_number/3 (Block.cxx:274).
    expect(ctx.sounds).toEqual([{ sound: 'block_dying', volume: 1 }]);
    expect(ctx.dying_count).toBe(1);
    expect(dying.state).toBe(BS_DYING);
    expect(dying.alarm).toBe(GC_DYING_DELAY);
    expect(ctx.grid.stateAt(0, 1)).toBe(GR_IMMUTABLE);
    expect(combo.involvement_count).toBe(1);

    for (let i = 0; i < GC_DYING_DELAY; i++) tick(ctx);

    expect(ctx.dying_count).toBe(0);
    expect(combo.involvement_count).toBe(0); // released on death
    expect(ctx.grid.stateAt(0, 1)).toBe(GR_EMPTY); // removed from the grid
    expect(ctx.blocks.storeMap[id]).toBe(false); // slot freed
  });

  it('pulls the block above into a combo fall when it pops', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_1); // floor
    ctx.blocks.newBlock(0, 1, BF_NORMAL_2); // dies
    ctx.blocks.newBlock(0, 2, BF_NORMAL_1); // should fall after the death
    const dying = ctx.grid.blockAt(0, 1);
    const above = ctx.grid.blockAt(0, 2);

    const combo = new ComboTabulator();
    combo.initialize(0);
    dying.startDying(ctx, combo, 5);

    for (let i = 0; i < GC_DYING_DELAY + 60; i++) tick(ctx);

    // the block above fell into the vacated cell and settled on the floor
    expect(above.y).toBe(1);
    expect(ctx.grid.blockAt(0, 1)).toBe(above);
    expect(ctx.grid.stateAt(0, 2)).toBe(GR_EMPTY);
  });
});

describe('Block swapping', () => {
  it('startSwapping marks the cell immutable and records the direction', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(2, 3, BF_NORMAL_1);
    const b = ctx.grid.blockAt(2, 3);

    b.startSwapping(ctx, SA_RIGHT);
    expect(b.state & BS_SWAPPING).toBeTruthy();
    expect(b.state & BS_SWAP_DIRECTION_MASK).toBeTruthy(); // right sets the mask
    expect(ctx.grid.stateAt(2, 3)).toBe(GR_IMMUTABLE);
  });

  it('a left swap does not set the direction mask', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(2, 3, BF_NORMAL_1);
    const b = ctx.grid.blockAt(2, 3);
    b.startSwapping(ctx, SA_LEFT);
    expect(b.state & BS_SWAP_DIRECTION_MASK).toBe(0);
  });

  it('finishSwapping re-homes the block at its new column', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(2, 3, BF_NORMAL_1);
    const b = ctx.grid.blockAt(2, 3);

    b.startSwapping(ctx, SA_RIGHT);
    ctx.grid.remove(2, 3, b); // Swapper clears the old cell before finishing
    b.finishSwapping(ctx, 3);

    expect(b.state).toBe(BS_STATIC);
    expect(b.x).toBe(3);
    expect(ctx.grid.blockAt(3, 3)).toBe(b);
  });
});

describe('Block awaking', () => {
  it('pops appearance at pop_alarm, then wakes to static and registers a check', () => {
    const ctx = new Ctx();
    ctx.blocks.newBlock(0, 0, BF_NORMAL_1); // support below (0, 1)
    const combo = new ComboTabulator();
    combo.initialize(0);

    const b = new Block();
    // clock is 0: pop at now+1, wake at now+3
    b.initializeAwaking(ctx, 0, 1, BF_NORMAL_2, 1, 3, combo, 0);
    expect(ctx.awaking_count).toBe(1);
    expect(b.state).toBe(BS_AWAKING);
    expect(combo.involvement_count).toBe(1);
    expect(ctx.grid.stateAt(0, 1)).toBe(GR_IMMUTABLE);

    ctx.clock.time_step = 1;
    b.timeStep(ctx); // pop_alarm fires (appearance + cue)
    expect(b.pop_alarm).toBe(0);
    expect(b.state).toBe(BS_AWAKING);
    // The pop cues block_awaking at volume 5 (Block.cxx:104).
    expect(ctx.sounds).toEqual([{ sound: 'block_awaking', volume: 5 }]);

    ctx.clock.time_step = 2;
    b.timeStep(ctx); // nothing at the boundary yet
    expect(b.state).toBe(BS_AWAKING);

    ctx.clock.time_step = 3;
    b.timeStep(ctx); // alarm === now: wake
    expect(ctx.awaking_count).toBe(0);
    expect(b.state).toBe(BS_STATIC); // supported below → stays put
    expect(ctx.grid.stateAt(0, 1)).toBe(GR_BLOCK);
    expect(ctx.grid.checkCount).toBeGreaterThanOrEqual(1);
  });

  it('an unsupported awaking block wakes straight into a fall', () => {
    const ctx = new Ctx();
    const combo = new ComboTabulator();
    combo.initialize(0);

    const b = new Block();
    b.initializeAwaking(ctx, 0, 1, BF_NORMAL_1, 1, 2, combo, 0); // nothing below

    ctx.clock.time_step = 2;
    b.timeStep(ctx); // wake; (0,0) empty → start falling (no-hang) and descend
    expect(ctx.awaking_count).toBe(0);
    expect(b.state & BS_FALLING).toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import { GC_BLOCK_STORE_SIZE, BF_NORMAL_1, BF_NORMAL_2 } from './constants.js';
import {
  BR_DIRECTION_1,
  BR_DIRECTION_2,
  BR_DIRECTION_3,
  BR_DIRECTION_4,
  BS_STATIC,
  BlockManager,
} from './block.js';
import { GR_BLOCK, Grid } from './grid.js';

describe('BlockManager store', () => {
  it('starts empty with a fully allocated pool', () => {
    const bm = new BlockManager(new Grid());
    expect(bm.block_count).toBe(0);
    expect(bm.blockStore).toHaveLength(GC_BLOCK_STORE_SIZE);
    expect(bm.blockStore.every((b, i) => b.id === i)).toBe(true);
    expect(bm.storeMap.every((m) => m === false)).toBe(true);
  });

  it('newBlock allocates the lowest free id and registers it in the grid', () => {
    const grid = new Grid();
    const bm = new BlockManager(grid);

    bm.newBlock(2, 3, BF_NORMAL_1);
    expect(bm.block_count).toBe(1);
    expect(bm.storeMap[0]).toBe(true);

    const block = bm.block(0);
    expect(block.state).toBe(BS_STATIC);
    expect(block.x).toBe(2);
    expect(block.y).toBe(3);
    expect(block.flavor).toBe(BF_NORMAL_1);

    // registered in the grid
    expect(grid.stateAt(2, 3)).toBe(GR_BLOCK);
    expect(grid.blockAt(2, 3)).toBe(block);
    expect(grid.flavorAt(2, 3)).toBe(BF_NORMAL_1);
  });

  it('deleteBlock frees the slot and lowers the count', () => {
    const bm = new BlockManager(new Grid());
    bm.newBlock(0, 0, BF_NORMAL_1);
    const block = bm.block(0);
    bm.deleteBlock(block);
    expect(bm.block_count).toBe(0);
    expect(bm.storeMap[0]).toBe(false);
  });

  it('reuses freed ids (lowest-first)', () => {
    const grid = new Grid();
    const bm = new BlockManager(grid);
    bm.newBlock(0, 0, BF_NORMAL_1); // id 0
    bm.newBlock(1, 0, BF_NORMAL_1); // id 1
    bm.deleteBlock(bm.block(0)); // frees slot 0
    bm.newBlock(3, 0, BF_NORMAL_2); // reuses id 0 (lowest free)
    expect(bm.block(0).x).toBe(3);
    expect(bm.block(0).flavor).toBe(BF_NORMAL_2);
  });

  it('newBlock is a no-op when the store is full', () => {
    // Use a tall single column fill within grid bounds is unnecessary; just
    // exercise the guard by faking a full count via many placements.
    const grid = new Grid();
    const bm = new BlockManager(grid);
    // Fill the grid legally: 6 wide * 45 tall = 270 === store size.
    let placed = 0;
    for (let x = 0; x < 6; x++) {
      for (let y = 0; y < 45; y++) {
        bm.newBlock(x, y, BF_NORMAL_1);
        placed++;
      }
    }
    expect(bm.block_count).toBe(GC_BLOCK_STORE_SIZE);
    expect(placed).toBe(GC_BLOCK_STORE_SIZE);
    // one more must be silently dropped
    const before = bm.block_count;
    bm.newBlock(0, 0, BF_NORMAL_1);
    expect(bm.block_count).toBe(before);
  });

  it('shiftUp increments y for every live block only', () => {
    const grid = new Grid();
    const bm = new BlockManager(grid);
    bm.newBlock(0, 0, BF_NORMAL_1);
    bm.newBlock(1, 5, BF_NORMAL_1);
    bm.shiftUp();
    expect(bm.block(0).y).toBe(1);
    expect(bm.block(1).y).toBe(6);
  });
});

describe('BlockManager pop-direction sequencing', () => {
  it('cycles through the four directions', () => {
    const bm = new BlockManager(new Grid());
    // starts at BR_DIRECTION_1; each call advances then returns
    expect(bm.generatePopDirection()).toBe(BR_DIRECTION_2);
    expect(bm.generatePopDirection()).toBe(BR_DIRECTION_3);
    expect(bm.generatePopDirection()).toBe(BR_DIRECTION_4);
    expect(bm.generatePopDirection()).toBe(BR_DIRECTION_1);
    expect(bm.generatePopDirection()).toBe(BR_DIRECTION_2);
  });

  it('generatePopDirectionN returns current and advances n steps', () => {
    const bm = new BlockManager(new Grid());
    // first advance to a known point
    bm.generatePopDirection(); // -> DIRECTION_2 is "current" next
    const got = bm.generatePopDirectionN(2);
    expect(got).toBe(BR_DIRECTION_3);
    // sequence advanced by 2 total from the returned value
    expect(bm.generatePopDirection()).toBe(BR_DIRECTION_1);
  });
});

import { describe, expect, it } from 'vitest';
import { GC_GARBAGE_STORE_SIZE, GC_HANG_DELAY } from './constants.js';
import { GF_BLACK, GF_GRAY, GF_NORMAL } from './flavors.js';
import { GS_FALLING, GS_STATIC, Garbage, GarbageManager } from './garbage.js';
import { GR_FALLING, GR_GARBAGE, Grid } from './grid.js';

describe('GarbageManager store', () => {
  it('starts empty with a fully allocated pool', () => {
    const gm = new GarbageManager(new Grid());
    expect(gm.garbage_count).toBe(0);
    expect(gm.garbageStore).toHaveLength(GC_GARBAGE_STORE_SIZE);
    expect(gm.garbageStore.every((g, i) => g.id === i)).toBe(true);
  });

  it('rolls back the allocation when placement fails (no leaked slot)', () => {
    const gm = new GarbageManager(new Grid());
    // invalid dimensions throw inside initializeFalling; the pool must not leak
    expect(() => gm.newFallingGarbage(0, 10, 0, 2, GF_NORMAL, 0)).toThrow(RangeError);
    expect(gm.garbage_count).toBe(0);
    expect(gm.storeMap[0]).toBe(false);
  });

  it('garbage(id) rejects an out-of-range id', () => {
    const gm = new GarbageManager(new Grid());
    expect(() => gm.garbage(-1)).toThrow(RangeError);
    expect(() => gm.garbage(GC_GARBAGE_STORE_SIZE)).toThrow(RangeError);
  });

  it('newFallingGarbage allocates and stamps all covered cells as FALLING', () => {
    const grid = new Grid();
    const gm = new GarbageManager(grid);

    gm.newFallingGarbage(0, 10, 2, 3, GF_NORMAL, 100);
    expect(gm.garbage_count).toBe(1);

    const g = gm.garbage(0);
    expect(g.state).toBe(GS_FALLING);
    expect(g.initial_fall).toBe(true);
    expect(g.alarm).toBe(100 + GC_HANG_DELAY);

    // 3 wide x 2 tall block of cells, all FALLING and pointing at g
    for (let w = 0; w < 3; w++) {
      for (let h = 0; h < 2; h++) {
        expect(grid.stateAt(0 + w, 10 + h)).toBe(GR_FALLING);
        expect(grid.garbageAt(0 + w, 10 + h)).toBe(g);
      }
    }
  });

  it('deleteGarbage frees the slot', () => {
    const gm = new GarbageManager(new Grid());
    gm.newFallingGarbage(0, 10, 1, 1, GF_NORMAL, 0);
    gm.deleteGarbage(gm.garbage(0));
    expect(gm.garbage_count).toBe(0);
    expect(gm.storeMap[0]).toBe(false);
  });

  it('shiftUp increments y for every live garbage', () => {
    const grid = new Grid();
    const gm = new GarbageManager(grid);
    gm.newFallingGarbage(0, 10, 1, 2, GF_NORMAL, 0);
    gm.newFallingGarbage(0, 20, 1, 2, GF_NORMAL, 0);
    gm.shiftUp();
    expect(gm.garbage(0).y).toBe(11);
    expect(gm.garbage(1).y).toBe(21);
  });

  it('shiftUp throws instead of hanging when garbage_count is out of sync', () => {
    const gm = new GarbageManager(new Grid());
    (gm as unknown as { garbage_count: number }).garbage_count = 2;
    expect(() => gm.shiftUp()).toThrow(/out of sync/);
  });
});

describe('Garbage.initializeStatic', () => {
  it('stamps a static slab into the grid', () => {
    const grid = new Grid();
    const g = new Garbage();
    g.initializeStatic(1, 2, 2, 2, GF_NORMAL, grid);
    expect(g.state).toBe(GS_STATIC);
    for (let w = 0; w < 2; w++) {
      for (let h = 0; h < 2; h++) {
        expect(grid.stateAt(1 + w, 2 + h)).toBe(GR_GARBAGE);
        expect(grid.garbageAt(1 + w, 2 + h)).toBe(g);
      }
    }
  });

  it('rejects non-positive dimensions', () => {
    const grid = new Grid();
    const g = new Garbage();
    expect(() => g.initializeStatic(0, 0, 0, 2, GF_NORMAL, grid)).toThrow(RangeError);
    expect(() => g.initializeStatic(0, 0, 2, -1, GF_NORMAL, grid)).toThrow(RangeError);
  });
});

describe('Garbage.considerShattering', () => {
  const make = (flavor: number): Garbage => {
    const g = new Garbage();
    g.flavor = flavor;
    return g;
  };

  it('always shatters when the cause is an adjacent elimination (null)', () => {
    expect(make(GF_NORMAL).considerShattering(null)).toBe(true);
    expect(make(GF_GRAY).considerShattering(null)).toBe(true);
    expect(make(GF_BLACK).considerShattering(null)).toBe(true);
  });

  it('gray only propagates from gray', () => {
    expect(make(GF_GRAY).considerShattering(make(GF_GRAY))).toBe(true);
    expect(make(GF_GRAY).considerShattering(make(GF_NORMAL))).toBe(false);
    expect(make(GF_GRAY).considerShattering(make(GF_BLACK))).toBe(false);
  });

  it('black only propagates from black', () => {
    expect(make(GF_BLACK).considerShattering(make(GF_BLACK))).toBe(true);
    expect(make(GF_BLACK).considerShattering(make(GF_NORMAL))).toBe(false);
  });

  it('normal garbage shatters from normal but not from gray', () => {
    expect(make(GF_NORMAL).considerShattering(make(GF_NORMAL))).toBe(true);
    expect(make(GF_NORMAL).considerShattering(make(GF_GRAY))).toBe(false);
  });
});

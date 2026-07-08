import { describe, expect, it } from 'vitest';
import {
  BF_BLACK,
  BF_NORMAL_1,
  GC_AVERAGE_GARBAGE_DROP_DELAY,
  GC_PLAY_WIDTH,
  GC_SPREAD_GARBAGE_DROP_DELAY,
} from './constants.js';
import { Block } from './block.js';
import { Clock } from './clock.js';
import { ComboTabulator } from './combo.js';
import { ComboManager } from './comboManager.js';
import { GF_BLACK, GF_GRAY, GF_NORMAL, mapSpecialFlavorToCode } from './flavors.js';
import { GarbageManager } from './garbage.js';
import { GarbageGenerator, type GarbageOutSink } from './garbageGenerator.js';
import { GR_GARBAGE, Grid } from './grid.js';
import { Rng } from './rng.js';

class RecordingSink implements GarbageOutSink {
  normal: Array<[number, number, number]> = [];
  special: number[] = [];
  sendGarbage(height: number, width: number, flavor: number): void {
    this.normal.push([height, width, flavor]);
  }
  sendSpecialGarbage(flavor: number): void {
    this.special.push(flavor);
  }
}

interface Rig {
  clock: Clock;
  rng: Rng;
  grid: Grid;
  gm: GarbageManager;
  gg: GarbageGenerator;
  cm: ComboManager;
}

const newRig = (seed = 1): Rig => {
  const clock = new Clock();
  const rng = new Rng(seed);
  const grid = new Grid();
  const gm = new GarbageManager(grid, rng);
  const gg = new GarbageGenerator(clock, rng, gm);
  const cm = new ComboManager(clock, gg);
  return { clock, rng, grid, gm, gg, cm };
};

const comboWith = (fields: Partial<ComboTabulator>): ComboTabulator => {
  const c = new ComboTabulator();
  c.initialize(0);
  Object.assign(c, fields);
  return c;
};

describe('GarbageGenerator.comboElimination — normal magnitude bands', () => {
  const sends = (magnitude: number): Array<[number, number, number]> => {
    const { gg } = newRig();
    const sink = new RecordingSink();
    gg.outSink = sink;
    gg.comboElimination(comboWith({ magnitude }));
    return sink.normal;
  };

  it('sends nothing at or below the minimum pattern length', () => {
    expect(sends(3)).toEqual([]);
  });

  it('sends one row of (magnitude - 1) up to the play width', () => {
    expect(sends(4)).toEqual([[1, 3, GF_NORMAL]]);
    expect(sends(GC_PLAY_WIDTH)).toEqual([[1, GC_PLAY_WIDTH - 1, GF_NORMAL]]);
  });

  it('splits into two rows in the middle band', () => {
    // magnitude 7: widths (7 - 3) and 3
    expect(sends(7)).toEqual([
      [1, 4, GF_NORMAL],
      [1, 3, GF_NORMAL],
    ]);
  });

  it('emits full-width rows then a remainder in the top band', () => {
    // magnitude 11: +3 => 14; 14>5 -> width5 (9); 9>5 -> width5 (4); 4>=3 -> width4
    expect(sends(11)).toEqual([
      [1, GC_PLAY_WIDTH - 1, GF_NORMAL],
      [1, GC_PLAY_WIDTH - 1, GF_NORMAL],
      [1, 4, GF_NORMAL],
    ]);
  });

  it('clears the magnitude after emitting', () => {
    const { gg } = newRig();
    gg.outSink = new RecordingSink();
    const c = comboWith({ magnitude: 7 });
    gg.comboElimination(c);
    expect(c.magnitude).toBe(0);
  });
});

describe('GarbageGenerator.comboElimination — special / gray', () => {
  it('turns leftover special magnitude into gray rows', () => {
    const { gg } = newRig();
    const sink = new RecordingSink();
    gg.outSink = sink;
    // special_magnitude 5: -=1 => 4; then 3 gray sends as it counts down
    gg.comboElimination(comboWith({ special_magnitude: 5 }));
    expect(sink.special).toEqual([GF_GRAY, GF_GRAY, GF_GRAY]);
  });

  it('sends special garbage from a special tally and consumes it', () => {
    const { gg } = newRig();
    const sink = new RecordingSink();
    gg.outSink = sink;

    const c = comboWith({});
    c.special[mapSpecialFlavorToCode(BF_BLACK)] = 2; // two black special blocks
    gg.comboElimination(c);

    // black special code maps to GF_BLACK garbage, sent twice
    expect(sink.special).toEqual([GF_BLACK, GF_BLACK]);
    expect(c.special[mapSpecialFlavorToCode(BF_BLACK)]).toBe(0);
  });
});

describe('GarbageGenerator.comboComplete', () => {
  it('sends multiplier garbage only when the multiplier exceeds one', () => {
    const { gg } = newRig();
    const sink = new RecordingSink();
    gg.outSink = sink;

    gg.comboComplete(comboWith({ multiplier: 1 }));
    expect(sink.normal).toEqual([]);

    gg.comboComplete(comboWith({ multiplier: 3 }));
    expect(sink.normal).toEqual([[2, GC_PLAY_WIDTH, GF_NORMAL]]);
  });
});

describe('GarbageGenerator solo dealing + drop', () => {
  it('queues locally with a jittered drop time and later drops onto the board', () => {
    const { clock, gg, grid, gm } = newRig(2024);
    // solo: no outSink, so a 1x3 normal deal goes to the local queue
    gg.comboElimination(comboWith({ magnitude: 4 })); // -> deal 1x3 normal
    expect(gg.waitingCount).toBe(1);

    // advance past any possible drop alarm and drop it
    clock.time_step = GC_AVERAGE_GARBAGE_DROP_DELAY + GC_SPREAD_GARBAGE_DROP_DELAY + 10;
    gg.timeStep();

    expect(gg.waitingCount).toBe(0);
    // 1x3 garbage now sits on the board (fresh board drops at SAFE_HEIGHT + 1)
    expect(gm.garbage_count).toBe(1);
    let garbageCells = 0;
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 0; y < grid.top_occupied_row + 1; y++) {
        // freshly dropped garbage is in the GR_FALLING state but its resident
        // type is GR_GARBAGE
        if (grid.residentTypeAt(x, y) & GR_GARBAGE) garbageCells++;
      }
    }
    expect(garbageCells).toBe(3);
  });

  it('is deterministic: same seed yields the same drop alarm', () => {
    const drops: number[] = [];
    for (let i = 0; i < 2; i++) {
      const { gg } = newRig(777);
      gg.comboElimination(comboWith({ magnitude: 4 }));
      // waitingCount confirms exactly one queued element for both runs
      drops.push(gg.waitingCount);
    }
    expect(drops).toEqual([1, 1]);
  });
});

describe('ComboManager', () => {
  it('allocates and initializes combos from the pool', () => {
    const { clock, cm } = newRig();
    clock.time_step = 5;
    const combo = cm.newComboTabulator();
    expect(cm.comboCount).toBe(1);
    expect(combo.creation_time_stamp).toBe(5);
    expect(combo.multiplier).toBe(1);
  });

  it('specialBlockTally ignores base flavors and counts special ones', () => {
    const { cm } = newRig();
    const combo = cm.newComboTabulator();

    const base = new Block();
    base.flavor = BF_NORMAL_1;
    cm.specialBlockTally(combo, base);
    expect(combo.special.every((v) => v === 0)).toBe(true);

    const black = new Block();
    black.flavor = BF_BLACK;
    cm.specialBlockTally(combo, black);
    expect(combo.special[mapSpecialFlavorToCode(BF_BLACK)]).toBe(1);
  });

  it('completes a combo with no involvement and frees it', () => {
    const { cm, gg } = newRig();
    const sink = new RecordingSink();
    gg.outSink = sink;

    const combo = cm.newComboTabulator();
    combo.multiplier = 2;
    combo.involvement_count = 0;

    cm.timeStep();
    expect(cm.comboCount).toBe(0); // freed
    expect(sink.normal).toEqual([[1, GC_PLAY_WIDTH, GF_NORMAL]]); // multiplier garbage
  });

  it('emits elimination garbage for a combo that eliminated this tick', () => {
    const { clock, cm, gg } = newRig();
    const sink = new RecordingSink();
    gg.outSink = sink;

    const combo = cm.newComboTabulator();
    combo.involvement_count = 2; // still involved
    combo.magnitude = 4;
    combo.time_stamp = clock.time_step; // eliminated this tick

    cm.timeStep();
    expect(cm.comboCount).toBe(1); // not freed (still involved)
    expect(sink.normal).toEqual([[1, 3, GF_NORMAL]]);
  });
});

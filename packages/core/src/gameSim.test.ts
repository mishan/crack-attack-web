import { describe, expect, it } from 'vitest';
import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';
import { noActions } from './controller.js';
import { GF_NORMAL } from './flavors.js';
import { GameSim } from './gameSim.js';
import { GR_BLOCK, GR_EMPTY, GR_GARBAGE } from './grid.js';

/** Snapshot the grid as a per-cell string of state|flavor, for equality checks. */
const snapshot = (sim: GameSim): string => {
  const cells: string[] = [];
  for (let x = 0; x < GC_PLAY_WIDTH; x++) {
    for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
      const s = sim.grid.stateAt(x, y);
      const f = s & GR_BLOCK ? sim.grid.flavorAt(x, y) : -1;
      cells.push(`${s}:${f}`);
    }
  }
  return cells.join(',');
};

describe('GameSim gameStart', () => {
  it('starts the clock at zero with no awaking/dying blocks', () => {
    const sim = new GameSim(1);
    expect(sim.clock.time_step).toBe(0);
    expect(sim.awaking_count).toBe(0);
    expect(sim.dying_count).toBe(0);
  });

  it('fills the initial board and the first creep row (row 0)', () => {
    const sim = new GameSim(42);
    // row 0 is the first creep row, fully populated with blocks
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      expect(sim.grid.stateAt(x, 0)).toBe(GR_BLOCK);
    }
    // there are stacked blocks above row 0 too
    expect(sim.blocks.block_count).toBeGreaterThan(GC_PLAY_WIDTH);
  });

  it('is fully determined by the seed', () => {
    expect(snapshot(new GameSim(12345))).toBe(snapshot(new GameSim(12345)));
    expect(snapshot(new GameSim(1))).not.toBe(snapshot(new GameSim(2)));
  });

  it('gameStart reseeds, so a restart reproduces the starting position', () => {
    const sim = new GameSim(777);
    const fresh = snapshot(sim);
    // advance (consuming RNG draws), then restart on the same instance
    for (let i = 0; i < 25; i++) sim.step(noActions());
    sim.gameStart();
    expect(snapshot(sim)).toBe(fresh);
  });

  it('produces no immediate matches in the starting stack (rows 1+)', () => {
    const sim = new GameSim(2026);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
        if (!(sim.grid.stateAt(x, y) & GR_BLOCK)) continue;
        const f = sim.grid.flavorAt(x, y);
        if (y + 1 < GC_PLAY_HEIGHT && sim.grid.stateAt(x, y + 1) & GR_BLOCK) {
          expect(f).not.toBe(sim.grid.flavorAt(x, y + 1));
        }
        if (x + 1 < GC_PLAY_WIDTH && sim.grid.stateAt(x + 1, y) & GR_BLOCK) {
          expect(f).not.toBe(sim.grid.flavorAt(x + 1, y));
        }
      }
    }
  });
});

describe('GameSim.step', () => {
  it('advances the clock exactly one tick per call', () => {
    const sim = new GameSim(1);
    sim.step(noActions());
    expect(sim.clock.time_step).toBe(1);
    sim.step(noActions());
    expect(sim.clock.time_step).toBe(2);
  });

  it('is deterministic across identical seeds and inputs', () => {
    const a = new GameSim(99);
    const b = new GameSim(99);
    for (let i = 0; i < 50; i++) {
      a.step(noActions());
      b.step(noActions());
    }
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('runs the wired garbage generator each tick (queued garbage eventually drops)', () => {
    const sim = new GameSim(7);
    const garbageBefore = sim.garbageStore.garbage_count;
    // queue a 1x3 normal slab locally at the current tick
    sim.garbageGenerator.addToQueue(1, 3, GF_NORMAL, sim.clock.time_step);
    expect(sim.garbageGenerator.waitingCount).toBe(1);

    let dropped = false;
    for (let i = 0; i < 1000 && !dropped; i++) {
      sim.step(noActions());
      if (sim.garbageStore.garbage_count > garbageBefore) dropped = true;
    }

    expect(dropped).toBe(true);
    expect(sim.garbageGenerator.waitingCount).toBe(0);
    // the dropped slab occupies three cells (resident type GR_GARBAGE)
    let garbageCells = 0;
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
        if (sim.grid.residentTypeAt(x, y) & GR_GARBAGE) garbageCells++;
      }
    }
    expect(garbageCells).toBe(3);
  });

  it('leaves an empty cell reported as GR_EMPTY (sanity on the snapshot helper)', () => {
    const sim = new GameSim(3);
    // the very top row is always empty at game start
    expect(sim.grid.stateAt(0, GC_PLAY_HEIGHT - 1)).toBe(GR_EMPTY);
  });

  it('the starting stack is fully supported, so block physics leaves it unchanged', () => {
    // The initial board fills each column contiguously from the creep row up,
    // so no block is floating and nothing eliminates (no detector yet): stepping
    // must not move any block.
    const sim = new GameSim(20260708);
    const before = snapshot(sim);
    for (let i = 0; i < 20; i++) sim.step(noActions());
    expect(snapshot(sim)).toBe(before);
  });

  it('the valid starting board never spontaneously eliminates', () => {
    // The generator guarantees no immediate matches, so the elimination detector
    // must not fire on the starting board across many ticks and seeds.
    for (const seed of [1, 2, 3, 42, 20260708]) {
      const sim = new GameSim(seed);
      const blocksBefore = sim.blocks.block_count;
      for (let i = 0; i < 30; i++) sim.step(noActions());
      expect(sim.dying_count).toBe(0);
      expect(sim.blocks.block_count).toBe(blocksBefore);
    }
  });
});

describe('GameSim reward-sign sink', () => {
  it('wires the garbage generator to deliver signs to the sim buffer', () => {
    const sim = new GameSim(1);
    expect(sim.garbageGenerator.signSink).toBe(sim);
    expect(sim.signSink).toBe(sim);
  });

  it('drains emitted signs once, then reports empty', () => {
    const sim = new GameSim(1);
    sim.createSign(2, 5, 'magnitude', 1);
    sim.createSign(3, 6, 'multiplier', 0);
    const drained = sim.drainSignEvents();
    expect(drained).toEqual([
      { gridX: 2, gridY: 5, kind: 'magnitude', level: 1 },
      { gridX: 3, gridY: 6, kind: 'multiplier', level: 0 },
    ]);
    expect(sim.drainSignEvents()).toEqual([]);
  });

  it('clears undrained signs on restart', () => {
    const sim = new GameSim(1);
    sim.createSign(1, 1, 'special', 0);
    sim.gameStart();
    expect(sim.drainSignEvents()).toEqual([]);
  });

  it('caps the buffer for a never-drained run, keeping the newest', () => {
    const sim = new GameSim(1);
    for (let i = 0; i < 1000; i++) sim.createSign(i % GC_PLAY_WIDTH, 1, 'magnitude', i);
    const drained = sim.drainSignEvents();
    expect(drained.length).toBe(256);
    // the newest event (level 999) survived; the oldest were dropped
    expect(drained[drained.length - 1]!.level).toBe(999);
    expect(drained[0]!.level).toBe(1000 - 256);
  });
});

describe('GameSim cosmetic impact/spark/mote buffers', () => {
  it('drains impacts once, then reports empty', () => {
    const sim = new GameSim(1);
    sim.notifyCosmeticImpact(3, 1, 6);
    sim.notifyCosmeticImpact(5, 2, 3);
    expect(sim.drainImpactEvents()).toEqual([
      { y: 3, height: 1, width: 6 },
      { y: 5, height: 2, width: 3 },
    ]);
    expect(sim.drainImpactEvents()).toEqual([]);
  });

  it('drains spark bursts once, then reports empty', () => {
    const sim = new GameSim(1);
    sim.notifyCosmeticSpark(2, 4, 3, 7);
    expect(sim.drainSparkEvents()).toEqual([{ x: 2, y: 4, flavor: 3, count: 7 }]);
    expect(sim.drainSparkEvents()).toEqual([]);
  });

  it('drains reward motes once, then reports empty', () => {
    const sim = new GameSim(1);
    sim.createMote(1, 2, 14, 0);
    sim.createMote(1, 2, 3, 1);
    expect(sim.drainMoteEvents()).toEqual([
      { x: 1, y: 2, level: 14, sibling: 0 },
      { x: 1, y: 2, level: 3, sibling: 1 },
    ]);
    expect(sim.drainMoteEvents()).toEqual([]);
  });

  it('clears all cosmetic buffers on restart', () => {
    const sim = new GameSim(1);
    sim.notifyCosmeticImpact(3, 1, 6);
    sim.notifyCosmeticSpark(2, 4, 3, 7);
    sim.createMote(1, 2, 14, 0);
    sim.gameStart();
    expect(sim.drainImpactEvents()).toEqual([]);
    expect(sim.drainSparkEvents()).toEqual([]);
    expect(sim.drainMoteEvents()).toEqual([]);
  });

  it('caps each buffer for a never-drained run, keeping the newest', () => {
    const sim = new GameSim(1);
    for (let i = 0; i < 500; i++) {
      sim.notifyCosmeticImpact(i, 1, 1);
      sim.notifyCosmeticSpark(i, 1, 0, 1);
      sim.createMote(i, 1, 0, 0);
    }
    const impacts = sim.drainImpactEvents();
    expect(impacts.length).toBe(64);
    expect(impacts[impacts.length - 1]!.y).toBe(499);
    expect(impacts[0]!.y).toBe(500 - 64);

    const sparks = sim.drainSparkEvents();
    expect(sparks.length).toBe(128);
    expect(sparks[sparks.length - 1]!.x).toBe(499);
    expect(sparks[0]!.x).toBe(500 - 128);

    const motes = sim.drainMoteEvents();
    expect(motes.length).toBe(64);
    expect(motes[motes.length - 1]!.x).toBe(499);
    expect(motes[0]!.x).toBe(500 - 64);
  });

  it('is wired as the sink for block deaths and garbage payouts', () => {
    const sim = new GameSim(1);
    // The generator's sign sink (which carries createMote) is the sim itself,
    // and blocks reach the spark/impact hooks through their sim context.
    expect(sim.garbageGenerator.signSink).toBe(sim);
    expect(typeof sim.notifyCosmeticSpark).toBe('function');
    expect(typeof sim.notifyCosmeticImpact).toBe('function');
  });
});

describe('GameSim cosmetic sound buffer', () => {
  it('drains sound cues once, then reports empty', () => {
    const sim = new GameSim(1);
    sim.notifyCosmeticSound('block_fallen', 2);
    sim.notifyCosmeticSound('garbage_shattering', 12);
    expect(sim.drainSoundEvents()).toEqual([
      { sound: 'block_fallen', volume: 2 },
      { sound: 'garbage_shattering', volume: 12 },
    ]);
    expect(sim.drainSoundEvents()).toEqual([]);
  });

  it('clears the sound buffer on restart', () => {
    const sim = new GameSim(1);
    sim.notifyCosmeticSound('block_dying', 4);
    sim.gameStart();
    expect(sim.drainSoundEvents()).toEqual([]);
  });

  it('caps the sound buffer for a never-drained run, keeping the newest', () => {
    const sim = new GameSim(1);
    for (let i = 0; i < 500; i++) sim.notifyCosmeticSound('block_awaking', i);
    const sounds = sim.drainSoundEvents();
    expect(sounds.length).toBe(128);
    expect(sounds[sounds.length - 1]!.volume).toBe(499);
    expect(sounds[0]!.volume).toBe(500 - 128);
  });

  it('is the sound sink reached through the block context', () => {
    const sim = new GameSim(1);
    expect(typeof sim.notifyCosmeticSound).toBe('function');
  });
});

describe('GameSim cosmetic score buffer', () => {
  const snap = (id: number) => ({
    id,
    creationTimeStamp: 0,
    magnitude: 3,
    specialMagnitude: 0,
    multiplier: 1,
    nMultipliers: 0,
    special: [0, 0, 0, 0, 0, 0, 0],
  });

  it('is wired as the combo manager score sink', () => {
    const sim = new GameSim(1);
    expect(sim.combos.scoreSink).toBe(sim);
  });

  it('drains score snapshots once, then reports empty', () => {
    const sim = new GameSim(1);
    sim.reportComboElimination(snap(0));
    sim.reportComboElimination(snap(1));
    expect(sim.drainScoreEvents().map((e) => e.id)).toEqual([0, 1]);
    expect(sim.drainScoreEvents()).toEqual([]);
  });

  it('clears the score buffer on restart', () => {
    const sim = new GameSim(1);
    sim.reportComboElimination(snap(0));
    sim.gameStart();
    expect(sim.drainScoreEvents()).toEqual([]);
  });

  it('caps the buffer for a never-drained run, keeping the newest', () => {
    const sim = new GameSim(1);
    for (let i = 0; i < 500; i++) sim.reportComboElimination(snap(i));
    const events = sim.drainScoreEvents();
    expect(events.length).toBe(128);
    expect(events[events.length - 1]!.id).toBe(499);
    expect(events[0]!.id).toBe(500 - 128);
  });
});

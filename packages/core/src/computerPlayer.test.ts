import { describe, expect, it } from 'vitest';
import { ComputerPlayer, GarbageQueue } from './computerPlayer.js';
import { GF_GRAY, GF_NORMAL } from './flavors.js';
import {
  GC_CREEP_ADVANCE_VELOCITY,
  GC_DYING_DELAY,
  GC_PLAY_WIDTH,
  GC_STEPS_PER_SECOND,
} from './constants.js';
import { Rng } from './rng.js';

describe('GarbageQueue', () => {
  it('sums total and special (non-normal) height', () => {
    const q = new GarbageQueue();
    q.add(2, 6, GF_NORMAL);
    q.add(1, 6, GF_GRAY);
    expect(q.height()).toBe(3);
    expect(q.specialHeight()).toBe(1);
  });

  it('removeWithSpecials removes the leading run up to the other flavor', () => {
    const q = new GarbageQueue();
    q.add(2, 6, GF_NORMAL); // leading normal, 2 rows tall
    q.add(1, 6, GF_GRAY);
    q.add(1, 6, GF_NORMAL);
    // first is normal → remove leading normals up to the first gray. The count
    // is of *elements* removed (1), NOT their row height (2) — faithful to the
    // reference's `num_removed` (see removeWithSpecials' note). Even though the
    // removed slab was 2 rows tall, the reference returns 1 here.
    expect(q.removeWithSpecials()).toBe(1);
    expect(q.height()).toBe(2); // gray(1) + normal(1) remain
  });

  it('returns 0 when the leading flavor is already the stop flavor, and on empty', () => {
    const q = new GarbageQueue();
    expect(q.removeWithSpecials()).toBe(0);
    q.add(1, 6, GF_GRAY);
    q.add(1, 6, GF_GRAY);
    // first is gray → stop flavor is normal; no normals, so all removed
    expect(q.removeWithSpecials()).toBe(2);
    expect(q.height()).toBe(0);
  });
});

const WAITING_STATE_STEPS = GC_CREEP_ADVANCE_VELOCITY * 5 + GC_DYING_DELAY * 5;

describe('ComputerPlayer — cadence', () => {
  it('first attack fires at baseSteps + waiting stateSteps (hard = ×5)', () => {
    const ai = new ComputerPlayer('hard', new Rng(1), 0);
    const expected = GC_STEPS_PER_SECOND * 5 + WAITING_STATE_STEPS;
    expect(ai.nextAttackTick()).toBe(expected);
    expect(ai.step(expected - 1)).toEqual([]); // not yet
    expect(ai.step(expected).length).toBeGreaterThan(0); // fires
  });

  it('easy attacks less often than hard', () => {
    const easy = new ComputerPlayer('easy', new Rng(1), 0);
    const hard = new ComputerPlayer('hard', new Rng(1), 0);
    expect(easy.nextAttackTick()).toBeGreaterThan(hard.nextAttackTick());
  });
});

describe('ComputerPlayer — attacks', () => {
  it('sends a ~4-row block from an empty queue', () => {
    const ai = new ComputerPlayer('hard', new Rng(1), 0);
    const attack = ai.step(ai.nextAttackTick());
    // working_height 12, num_normals 12 → one 4×6 normal block, no grays
    expect(attack).toEqual([{ height: 4, width: GC_PLAY_WIDTH, flavor: GF_NORMAL }]);
  });

  it('adds gray rows when its own queue is partly full', () => {
    const ai = new ComputerPlayer('hard', new Rng(1), 0);
    ai.addGarbage(5, 6, GF_NORMAL); // queue height 5 (below hard loss 20)
    const attack = ai.step(ai.nextAttackTick());
    // working_height 7 → 1 gray; num_normals 12 → 4×6 normal
    expect(attack).toContainEqual({ height: 1, width: GC_PLAY_WIDTH, flavor: GF_GRAY });
    expect(attack).toContainEqual({ height: 4, width: GC_PLAY_WIDTH, flavor: GF_NORMAL });
  });
});

describe('ComputerPlayer — loss + impact', () => {
  it('loses when its queue exceeds the difficulty loss height', () => {
    const ai = new ComputerPlayer('easy', new Rng(1), 0); // loss height 4
    ai.addGarbage(4, 6, GF_NORMAL);
    expect(ai.lost).toBe(false); // 4 is not > 4
    ai.addGarbage(1, 6, GF_NORMAL);
    expect(ai.lost).toBe(true); // 5 > 4
  });

  it('flags an impact on incoming garbage, cleared on read', () => {
    const ai = new ComputerPlayer('hard', new Rng(1), 0);
    expect(ai.takeImpact()).toBe(false);
    ai.addGarbage(1, 6, GF_NORMAL);
    expect(ai.takeImpact()).toBe(true);
    expect(ai.takeImpact()).toBe(false);
  });

  it('shatters its own queue when it attacks (queue shrinks)', () => {
    const ai = new ComputerPlayer('hard', new Rng(3), 0);
    ai.addGarbage(2, 6, GF_NORMAL);
    ai.addGarbage(2, 6, GF_NORMAL);
    const before = ai.queueHeight();
    ai.step(ai.nextAttackTick()); // garbageAmount + shatter
    expect(ai.queueHeight()).toBeLessThan(before);
  });
});

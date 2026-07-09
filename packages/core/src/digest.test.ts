import { describe, expect, it } from 'vitest';
import {
  ActionState,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SWAP,
  CC_UP,
  noActions,
} from './controller.js';
import { GameSim } from './gameSim.js';
import { Rng } from './rng.js';
import { StateHasher } from './digest.js';

/**
 * Deterministic pseudo-random action stream for driving a sim in tests. Uses
 * its own Rng so the gameplay stream is untouched; both sims in a comparison
 * consume identical copies.
 */
function scriptedActions(seed: number, ticks: number): ActionState[] {
  const r = new Rng(seed);
  const out: ActionState[] = [];
  for (let t = 0; t < ticks; t++) {
    let bits = 0;
    // Move often, swap frequently, so the board sees real activity.
    const roll = r.number(8);
    if (roll === 0) bits |= CC_LEFT;
    else if (roll === 1) bits |= CC_RIGHT;
    else if (roll === 2) bits |= CC_UP;
    else if (roll === 3) bits |= CC_DOWN;
    if (r.chanceIn(3)) bits |= CC_SWAP;
    out.push(new ActionState(bits));
  }
  return out;
}

describe('StateHasher', () => {
  it('is order-sensitive and value-sensitive', () => {
    const a = new StateHasher();
    a.add(1);
    a.add(2);
    const b = new StateHasher();
    b.add(2);
    b.add(1);
    const c = new StateHasher();
    c.add(1);
    c.add(2);
    expect(a.value).not.toBe(b.value);
    expect(a.value).toBe(c.value);
  });

  it('normalizes int32/uint32 representations of the same word', () => {
    const a = new StateHasher();
    a.add(-1);
    const b = new StateHasher();
    b.add(0xffffffff);
    expect(a.value).toBe(b.value);
  });
});

describe('GameSim.digest', () => {
  it('is identical across sims given the same seed and inputs', () => {
    const simA = new GameSim(0xc0ffee);
    const simB = new GameSim(0xc0ffee);
    const actions = scriptedActions(42, 2000);
    expect(simA.digest()).toBe(simB.digest());
    for (let t = 0; t < actions.length; t++) {
      simA.step(actions[t]!);
      simB.step(actions[t]!);
      expect(simA.digest()).toBe(simB.digest());
    }
  });

  it('differs across seeds', () => {
    expect(new GameSim(1).digest()).not.toBe(new GameSim(2).digest());
  });

  it('detects input divergence', () => {
    const simA = new GameSim(0xdead);
    const simB = new GameSim(0xdead);
    const actions = scriptedActions(7, 600);
    // Identical for 300 ticks...
    for (let t = 0; t < 300; t++) {
      simA.step(actions[t]!);
      simB.step(actions[t]!);
    }
    expect(simA.digest()).toBe(simB.digest());
    // ...then B misses one swap press. The cursor/swap state diverges at once.
    simA.step(new ActionState(CC_SWAP));
    simB.step(noActions());
    let diverged = simA.digest() !== simB.digest();
    for (let t = 301; t < actions.length && !diverged; t++) {
      simA.step(actions[t]!);
      simB.step(actions[t]!);
      diverged = simA.digest() !== simB.digest();
    }
    expect(diverged).toBe(true);
  });

  it('is pure: computing digests does not perturb the sim', () => {
    const control = new GameSim(0xbeef);
    const probed = new GameSim(0xbeef);
    const actions = scriptedActions(9, 500);
    for (let t = 0; t < actions.length; t++) {
      control.step(actions[t]!);
      probed.step(actions[t]!);
      // Digest the probed sim excessively; the control sim only at the end.
      probed.digest();
      probed.digest();
    }
    expect(probed.digest()).toBe(control.digest());
    expect(probed.rng.state).toBe(control.rng.state);
  });

  it('restart reproduces the fresh-sim digest', () => {
    const sim = new GameSim(0xfeed);
    const fresh = sim.digest();
    const actions = scriptedActions(3, 400);
    for (const a of actions) sim.step(a);
    expect(sim.digest()).not.toBe(fresh);
    sim.gameStart();
    expect(sim.digest()).toBe(fresh);
  });
});

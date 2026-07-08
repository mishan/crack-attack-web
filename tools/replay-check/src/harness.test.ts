import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalize, digestState, snapshotState } from './digest.js';
import { firstDivergence, formatDivergence } from './diff.js';
import { runReplay, type DigestStream, type Replay } from './replay.js';
import { ActionState, GameSim, noActions } from '@crack-attack/core';

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

const loadReplay = (): Replay =>
  JSON.parse(readFileSync(fixture('solo-advance.replay.json'), 'utf8')) as Replay;
const loadGolden = (): DigestStream =>
  JSON.parse(readFileSync(fixture('solo-advance.digests.json'), 'utf8')) as DigestStream;

describe('digest', () => {
  it('is stable across two snapshots of the same fresh sim', () => {
    expect(digestState(new GameSim(1))).toBe(digestState(new GameSim(1)));
  });

  it('differs for different seeds (initial board fill diverges)', () => {
    expect(digestState(new GameSim(1))).not.toBe(digestState(new GameSim(2)));
  });

  it('canonical string reflects the fields the digest hashes', () => {
    const s = snapshotState(new GameSim(1));
    const canon = canonicalize(s);
    expect(canon).toContain(`t=${s.timeStep}`);
    expect(canon).toContain(`bc=${s.blockCount}`);
    // the initial board fill leaves the top rows empty, so not every cell is set
    expect(s.cells.length).toBe(s.blockCount);
  });
});

describe('runReplay', () => {
  it('produces ticks + 1 digests (initial position + one per step)', () => {
    const replay = loadReplay();
    const stream = runReplay(replay);
    expect(stream.digests.length).toBe(replay.ticks + 1);
    expect(stream.seed).toBe(replay.seed);
  });

  it('is deterministic: the same replay yields an identical stream', () => {
    const replay = loadReplay();
    const a = runReplay(replay);
    const b = runReplay(replay);
    expect(firstDivergence(a.digests, b.digests)).toBeNull();
  });

  it('matches the committed golden master', () => {
    const divergence = firstDivergence(runReplay(loadReplay()).digests, loadGolden().digests);
    expect(formatDivergence(divergence)).toBe('streams match');
  });

  it('rejects out-of-range and duplicate action ticks', () => {
    expect(() => runReplay({ seed: 1, ticks: 5, actions: [{ tick: 9, command: 0 }] })).toThrow();
    expect(() =>
      runReplay({
        seed: 1,
        ticks: 5,
        actions: [
          { tick: 2, command: 0 },
          { tick: 2, command: 1 },
        ],
      }),
    ).toThrow();
  });

  it('rejects a malformed command bitmask (stray bit or non-integer)', () => {
    expect(() =>
      runReplay({ seed: 1, ticks: 5, actions: [{ tick: 1, command: 1 << 20 }] }),
    ).toThrow(/valid CC_\* mask/);
    expect(() => runReplay({ seed: 1, ticks: 5, actions: [{ tick: 1, command: 1.5 }] })).toThrow();
    expect(() => runReplay({ seed: 1, ticks: 5, actions: [{ tick: 1, command: -4 }] })).toThrow();
  });
});

describe('firstDivergence', () => {
  it('returns null for identical streams', () => {
    expect(firstDivergence(['a', 'b', 'c'], ['a', 'b', 'c'])).toBeNull();
  });

  it('pinpoints the first differing tick', () => {
    const d = firstDivergence(['a', 'b', 'x', 'd'], ['a', 'b', 'c', 'd']);
    expect(d).toEqual({ tick: 2, actual: 'x', expected: 'c', reason: 'mismatch' });
  });

  it('flags a truncated stream at the first missing index', () => {
    expect(firstDivergence(['a', 'b'], ['a', 'b', 'c'])?.reason).toBe('actual-shorter');
    expect(firstDivergence(['a', 'b', 'c'], ['a', 'b'])?.reason).toBe('expected-shorter');
  });

  it('detects a real one-tick perturbation in a replay stream', () => {
    // Mutating a single input command must change the digest from that tick on.
    const base = runReplay(loadReplay());
    const perturbed = runReplay({
      ...loadReplay(),
      actions: [{ tick: 1, command: 2 /* right */ }],
    });
    const d = firstDivergence(perturbed.digests, base.digests);
    expect(d).not.toBeNull();
    expect(d!.tick).toBe(1); // first step where the extra input takes effect
  });
});

describe('restart equivalence', () => {
  it('gameStart on a used sim reproduces a fresh sim, tick for tick', () => {
    const seed = 777;
    const commands = [0, 32, 32, 4, 16, 0, 8, 32]; // arbitrary input sequence

    // A reference run on a fresh instance.
    const reference: string[] = [];
    const fresh = new GameSim(seed);
    reference.push(digestState(fresh));
    for (const c of commands) {
      fresh.step(c === 0 ? noActions() : new ActionState(c));
      reference.push(digestState(fresh));
    }

    // Dirty a second instance, restart it, then run the same inputs.
    const reused = new GameSim(seed);
    for (let i = 0; i < 40; i++) reused.step(new ActionState(32 /* advance */));
    reused.gameStart();

    const replayed: string[] = [digestState(reused)];
    for (const c of commands) {
      reused.step(c === 0 ? noActions() : new ActionState(c));
      replayed.push(digestState(reused));
    }

    expect(firstDivergence(replayed, reference)).toBeNull();
  });
});

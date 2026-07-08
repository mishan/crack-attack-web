/**
 * diff.ts
 *
 * Compare two per-tick digest streams and report the first tick at which they
 * diverge. This is the payoff of the harness: a faithful port matches the
 * reference at every tick, and the first mismatch localizes the buggy tick (and,
 * by re-running with `snapshotState`, the exact field). The reference stream can
 * be a stored golden master or a dump from the instrumented C++ build — both are
 * just `string[]` of the same digest format.
 */

/** A single point of disagreement between two digest streams. */
export interface Divergence {
  /** The tick index (0 = initial position). */
  readonly tick: number;
  /** Digest from the stream under test, or null if it ended early. */
  readonly actual: string | null;
  /** Digest from the reference stream, or null if it ended early. */
  readonly expected: string | null;
  /** Human-readable reason: a value mismatch or a length mismatch. */
  readonly reason: 'mismatch' | 'actual-shorter' | 'expected-shorter';
}

/**
 * Return the first divergence between `actual` and `expected`, or null if they
 * are identical (same length, same digest at every tick). A length difference
 * is reported at the first missing index so truncated runs are still caught.
 */
export function firstDivergence(
  actual: readonly string[],
  expected: readonly string[],
): Divergence | null {
  const n = Math.max(actual.length, expected.length);
  for (let t = 0; t < n; t++) {
    const a = t < actual.length ? actual[t]! : null;
    const e = t < expected.length ? expected[t]! : null;
    if (a === e) continue;
    const reason: Divergence['reason'] =
      a === null ? 'actual-shorter' : e === null ? 'expected-shorter' : 'mismatch';
    return { tick: t, actual: a, expected: e, reason };
  }
  return null;
}

/** Format a divergence (or its absence) as a one-line human-readable string. */
export function formatDivergence(d: Divergence | null): string {
  if (!d) return 'streams match';
  switch (d.reason) {
    case 'actual-shorter':
      return `diverge at tick ${d.tick}: actual stream ended, expected ${d.expected}`;
    case 'expected-shorter':
      return `diverge at tick ${d.tick}: expected stream ended, actual ${d.actual}`;
    default:
      return `diverge at tick ${d.tick}: actual ${d.actual} != expected ${d.expected}`;
  }
}

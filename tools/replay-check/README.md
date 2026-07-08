# replay-check

Golden-master faithfulness harness. Runs a fixed seed + recorded action stream
through `@crack-attack/core`, computes a per-tick **state digest**, and diffs it
against a reference stream. The first divergent tick pinpoints the buggy
subsystem — this is how the port's faithfulness is verified, not by eyeballing.

## What it does

- **`digest.ts`** — a compact, deterministic fingerprint of a `GameSim`'s
  gameplay state at one tick (grid contents, swap cursor, creep, awaking/dying/
  loss bookkeeping). It is **generator-agnostic**: it hashes integer sim state,
  never any PRNG internals, so a TS digest and a C++ digest are directly
  comparable even though the two builds use different RNGs.
- **`replay.ts`** — the `Replay` format (`{ seed, ticks, actions }`, where
  `actions` is a sparse per-tick command list) and `runReplay`, which produces a
  `DigestStream` (`ticks + 1` digests; index 0 is the starting position).
- **`diff.ts`** — `firstDivergence` reports the first tick two streams disagree.
- **`cli.ts`** — command-line wrapper.

## Usage

```sh
pnpm --filter @crack-attack/replay-check build

# Print the digest stream for a replay:
node tools/replay-check/dist/cli.js <replay.json>

# Diff a replay against a reference (golden master or C++ dump):
node tools/replay-check/dist/cli.js <replay.json> <reference.json>
```

A `<reference.json>` is either a raw `string[]` of digests or a
`{ seed, digests }` object. Exit code is 1 on a divergence, 0 on a match.

## Fixtures

`fixtures/solo-advance.replay.json` is a sample replay and
`fixtures/solo-advance.digests.json` its golden digest stream. `harness.test.ts`
re-runs the replay and asserts it still matches — so any change that perturbs the
deterministic core (a stray RNG draw, a reordered tick step) fails CI here.

## Cross-validating against C++ (next step)

The other half of the harness is upstream in the reference build: instrument the
C++ (`--enable-debug`) to (a) accept a fixed seed, (b) replay a `(tick, actions)`
stream via its existing `ActionRecorder` (CM_REPLAY), and (c) dump a per-tick
digest computed from the **same fields in the same order** as
`digest.ts#canonicalize`. Feed that dump in as the `<reference.json>` and the
diff localizes the first tick the port drifts from the original. Because
cosmetic systems share the C++ RNG stream, gameplay RNG draws are validated
separately via a draw log (see `BROWSER_PORT_PLAN.md`), not by this digest.

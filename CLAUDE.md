# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A browser port of **Crack Attack!** (a GPL clone of Tetris Attack) from C++/OpenGL
to TypeScript. The end goal: the same real-time block-matching game running in the
browser with Three.js rendering and server-relayed lockstep multiplayer plus a lobby.

The original C++ source lives under `crack-attack/` as the **reference
implementation** — we port from it, we don't build it. It is kept locally in the
workspace but **gitignored, not committed** (it's a large upstream tree; read it
in place). Its own `crack-attack/CLAUDE.md` documents that codebase; read it to
understand the game rules. The strategy and phase
plan live in `BROWSER_PORT_PLAN.md` (author-owned — treat as the source of truth for
direction; don't reformat it).

## Guiding principle

The port is a **faithful, tick-for-tick translation of the game rules**. All gameplay
is integer arithmetic on grid state, driven at a fixed 50 Hz, with randomness from a
single seeded source. Rendering, input, audio, and transport are replaceable platform
layers. Translate the rules layer mechanically (same constants, same tick order, same
integer math); rewrite the platform layers idiomatically for the web. Faithfulness is
verified by replay/digest comparison against the C++ build — not by eyeballing.

Keep simulation state **integer-only**. Floats leaking into sim state would threaten
cross-runtime determinism. Floats are fine in the render layer.

## Repo layout

```
packages/
  core/      # deterministic simulation — ZERO deps, runs in browser & Node
  protocol/  # wire message types shared by client and server (platform-agnostic)
  client/    # Three.js renderer, input, HUD, audio (Vite app) — WIP
  server/    # lobby + lockstep relay (Node, ws) — WIP
tools/
  replay-check/  # golden-master harness: core vs C++ per-tick digests (planned)
  obj2gltf/      # one-time .obj -> glTF asset conversion (planned)
crack-attack/    # upstream C++ reference source — local only, gitignored (port from it)
```

**Hard rule:** `core` and `protocol` must never import DOM or Node APIs. This is
enforced by ESLint (`no-restricted-imports` / `no-restricted-globals` on those paths)
and is load-bearing for determinism. If lint stops you here, that's the guard working.

## Toolchain

pnpm workspaces, TypeScript (strict, project references), Vitest, ESLint (flat
config) + Prettier. Node >= 20.

```sh
pnpm install
pnpm build          # tsc -b across all packages (project references)
pnpm test           # vitest run (co-located *.test.ts)
pnpm test:watch
pnpm typecheck      # tsc -b
pnpm lint           # eslint .
pnpm format         # prettier --write .
pnpm format:check
pnpm clean          # tsc -b --clean
```

Tests are co-located with source as `*.test.ts` and excluded from package builds
(see each package's `tsconfig.json` and the root `vitest.config.ts`).

### Sandbox note

If `pnpm` isn't on PATH (e.g. a fresh sandbox), it's available through Corepack:
`export COREPACK_HOME=/tmp/corepack && corepack pnpm@9 <cmd>`. Normal dev machines
just use `pnpm` directly.

## Conventions

- ES modules throughout (`"type": "module"`). Relative imports inside a package use
  explicit `.js` extensions (e.g. `import { Rng } from './rng.js'`) — required by
  `moduleResolution: Bundler` + `verbatimModuleSyntax`. Cross-package imports use the
  package name (`@crack-attack/core`).
- Ported constants and logic carry a source reference back to the C++ file and line
  (e.g. `Game.h:145`). Keep these — they make faithfulness auditable. Do not "tidy"
  transcribed numbers.
- Ported struct/state fields deliberately keep the C++ `snake_case` names
  (`block_count`, `top_occupied_row`, `f_y`, ...) so the sim reads one-to-one
  against the reference and desyncs are easy to trace. This is an intentional
  exception to idiomatic TS camelCase for the simulation's internal surface; a
  Phase 2 client-facing facade can expose idiomatic names if needed. New TS-only
  API (methods, the RNG helpers, etc.) stays camelCase.
- Prefer typed arrays / plain objects and fixed-size stores in the sim; no allocation
  during play (mirrors the C++ object stores).
- The RNG (`packages/core/src/rng.ts`) mirrors the C++ `Random` helper API
  (`chanceIn`, `number`, `number2`, ...) so gameplay code ports one-to-one. Determinism
  is about **call-order/sequence position** — auditing every gameplay `rand()` call site
  and matching draw order exactly is the #1 desync risk. Give cosmetics a separate,
  unsynced RNG so they don't perturb the gameplay stream.

## Git workflow

- Do all work on feature branches; `main` stays releasable.
- Commit messages: imperative subject, package-scoped where useful
  (e.g. `core: port Game.h constants`).
- **Do not add `Co-authored-by` trailers to commits.**
- Licensing: original is GPL v2; keep the port GPL-compatible
  (`GPL-2.0-or-later`), including any converted assets.

## Port status

- [x] Monorepo scaffold + tooling (pnpm, TS project refs, Vitest, ESLint/Prettier)
- [x] Phase 1.1 — `Game.h` gameplay constants → `packages/core/src/constants.ts`
- [x] Phase 1.2 — seedable PRNG → `packages/core/src/rng.ts` (production RNG;
      Mulberry32-based, serializable). C++ sequence-exact validation deferred to the
      RNG-draw-log harness.
- [x] Phase 1.3 — Grid + Block/Garbage stores → `grid.ts`, `block.ts`,
      `garbage.ts`, `flavors.ts` (element store + accessors, fixed-size object
      pools, flavor rules, check-registry linkage). Physics (`timeStep`),
      RNG-driven board/creep generation, combos, and `LevelLights` are deferred
      to the phases below and marked with `TODO(Phase …)` in-source.
- [~] Phase 1.4 — **generation + rise landed**: RNG creep-row generation
  (`BlockManager.newCreepRow`/`newCreepBlock`, non-X), initial board fill
  (`board.ts` `generateInitialBoard`), and grid rise (`Grid.shiftGridUp` +
  `board.ts` `shiftBoardUp`). All share one gameplay RNG stream; draw order
  matches the C++. **Deferred within 1.4** (need Controller/combos/GameSim):
  the Swapper input/swap-execution state machine and the Creep timer/loss
  state machine; `LevelLights` is a Displayer/Communicator subsystem → Phase 2.
- [ ] Phase 1.5 — Combos → garbage (ComboTabulator/GarbageGenerator/GarbageQueue)
- [ ] Phase 1.6 — `GameSim` tick driver (replicate `Game::timeStep` call order)
- [ ] Phase 1.7-1.8 — Controller/ActionState + ActionRecorder replay
- [ ] `tools/replay-check` digest harness + C++ instrumentation
- [ ] Phase 2 client, Phase 3 AI, Phase 4 multiplayer, Phase 5 lobby

See `BROWSER_PORT_PLAN.md` for the full phase breakdown and suggested order of work.

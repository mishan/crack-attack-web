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
  replay-check/  # golden-master harness: core vs C++ per-tick digests
  obj2gltf/      # one-time Wavefront OBJ (+MTL) -> glTF 2.0 asset conversion
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
- [x] Phase 1.4 — **generation + rise + Creep landed**: RNG creep-row generation
      (`BlockManager.newCreepRow`/`newCreepBlock`, non-X), initial board fill
      (`board.ts` `generateInitialBoard`), grid rise (`Grid.shiftGridUp` +
      `board.ts` `shiftBoardUp`, now including `Swapper.shiftUp`), and the Creep
      state machine (`creep.ts`): velocity ramp, safe-height freeze, loss countdown,
      per-grid board rise + fresh creep row + elimination linking, and manual
      advance. All share one gameplay RNG stream; draw order matches the C++. Creep
      owns the first-row draw in `gameStart` and runs at the `Game::idlePlay`
      position in `GameSim.step`; loss routes through a `notifyLoss` hook
      (`GameSim.lost`). `LevelLights`/`LoseBar` are Displayer/Communicator
      subsystems → Phase 2.
- [x] Phase 1.5 — Combos → garbage: `combo.ts` (ComboTabulator), `comboManager.ts`,
      `garbageGenerator.ts` (magnitude/multiplier → garbage dimensions + flavors,
      drop-delay queue, per-tick drop), plus `GarbageManager.newFallingGarbage`
      drop-placement and a shared `clock.ts`. Outbound garbage routes through an
      injectable `GarbageOutSink` (solo deals locally; netcode/AI plug in here).
      Score reporting (display) and cosmetic Sign/Sparkle effects deferred; the
      `GarbageQueue` class is AI-only → Phase 3.
- [x] Phase 1.6 — **GameSim driver + Block physics + elimination detector
      landed**: `gameSim.ts` owns the Clock, gameplay Rng, Grid, and all managers;
      `gameStart` wires the C++ RNG-draw order (board fill → first creep row);
      `step(actions)` replicates `Game::idlePlay`'s gameplay tick order (step block
      residents → `Grid.timeStep` → ComboManager → GarbageGenerator). Block physics
      (`block.ts` `timeStep` fall/hang/dying/awaking + `startFalling`/`startDying`/
      `startSwapping`/`finishSwapping`/`initializeAwaking`) and the Grid elimination
      detector (`Grid.timeStep` drain + `handleEliminationCheckRequest` 4-direction
      pattern scan → `startDying` → combo) run against a `BlockSimContext` /
      `GridSimContext` (GameSim). Cosmetic death axes use a separate unsynced
      `cosmeticRng`.
- [x] Phase 1.4/1.6 — **Swapper landed** (`swapper.ts`): input-driven cursor
      move (rate-limited by `GC_MOVE_DELAY`) and the swap state machine
      (allow/disallow checks, `GC_SWAP_DELAY` execution, two-sided swaps link a
      shared combo, queued move/swap debounce, `notifyLanding`). Wired into
      `GameSim.step` at the `Game::idlePlay` position; `notifyLanding` now delegates
      to it. X `reverseControls` and the `CountDownManager` intro gate deferred;
      `swap_factor`/`color` are render-only and left to the client.
- [x] Phase 1.6 — **Garbage physics landed** (`garbage.ts`): `Garbage.timeStep`
      (fall-start check → `startFalling`, awaking pop countdown, per-cell fall +
      landing `notifyImpact`), `startFalling` (hang alarm, grid restamp, upward
      combo-fall cascade into blocks/garbage), and `initializeAwaking`. Wired into
      `GameSim.stepResidents` (garbage advances the walk cursor over its footprint)
      and the `startGarbageFalling` hook.
- [x] Phase 1.6 — **Garbage shattering landed**: an elimination touching a slab
      now shatters it. `Grid.shatterGarbage` marks connected garbage (gray/black
      consent rules), and a synchronization pass drives `Garbage.startShattering`,
      converting each row into staggered-pop awaking blocks
      (`BlockManager.newAwakingBlock`, with its own `*_a` flavor history) or, for
      shatter-to-garbage flavors/odd full-width rows, a fresh awaking garbage
      (`GarbageManager.newAwakingGarbage`). The garbage-to-garbage `chanceIn`
      draw is short-circuited exactly as in the C++ to preserve RNG order.
      Sound/Spring/X extreme effects are render-only and omitted.
- [~] Phase 1.7 (partial) — Controller/ActionState input snapshot (`controller.ts`);
  ActionRecorder replay still to come.
- [ ] `tools/replay-check` digest harness + C++ instrumentation
- [ ] Phase 2 client, Phase 3 AI, Phase 4 multiplayer, Phase 5 lobby

See `BROWSER_PORT_PLAN.md` for the full phase breakdown and suggested order of work.

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
config) + Prettier. Node `^20.19.0 || >=22.12.0` (the client's Vite 8 requirement).

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
- [~] Phase 2 — **client shell landed** (`packages/client`, Vite + Three.js):
  a playable solo board. The platform layers around the deterministic core are
  split so the sim-facing ones stay DOM-free and unit-tested — `FixedTimestep`
  (50 Hz wall-clock accumulator + interpolation alpha), `KeyboardInput`
  (rebindable `code`→`CC_*` map; normalizes combined directions to a single
  move, since the Swapper faithfully ignores multi-direction masks; on touch /
  coarse-pointer devices `input/touchControls.ts` mounts an on-screen D-pad +
  swap/raise/restart overlay that feeds the same `KeyboardInput` via those key
  codes), and `deriveViewModel` (sim state → render sprites), and `ViewInterpolator`
  (blends the last two ticks by the render `alpha`, matching sprites by pool
  `(id, generation)`, so motion is smooth above 50 Hz). `BoardView` (Three.js
  instanced meshes) and `main.ts` (RAF loop, input listeners, restart) are the
  thin DOM/WebGL layer. Blocks render the real rounded-cube glTF model
  (`public/models/block.gltf`, converted by `tools/obj2gltf`), loaded via
  `GLTFLoader` and swapped into the block `InstancedMesh` (box fallback until it
  arrives), lit as glossy plastic (a `MeshPhongMaterial` with a gray specular
  highlight) by a camera-side "headlight" — faithful to the reference's
  `GL_SPECULAR`/`GL_SHININESS` + `DC_HEADLIGHT_*` setup — so the beveled facets
  gleam. A swap animates as a revolving door: `deriveViewModel` exposes each
  swapping block's `swapFactor` (from the swapper's `swap_alarm`, interpolated
  between ticks) and `swapRight`, and `BoardView` swings the block a semicircle
  around the edge it shares with its partner (faithful to the `swap_factor`
  transform in `DrawBlocks.cxx`), so the two blocks pass on opposite sides.
  Blocks minted when garbage shatters pop in one-by-one: `deriveViewModel` reports
  each awaking block's `awakeProgress` (from its `pop_alarm`, staggered per block
  and interpolated between ticks), and `BoardView` grows it (0.5→1), tumbles it
  into alignment, and eases its colour from the garbage flavour to the block
  flavour — faithful to the `BS_AWAKING` pop in `DrawBlocks.cxx`.
  The incoming creep row (grid row 0) rises in from off-screen: a
  world-space clip plane on the block/garbage materials at the row 0 / row 1
  boundary (faithful to `GL_CLIP_PLANE_PLAY_FLOOR`) hides it below the play floor,
  so it slides up dim (`creep_colors` at 0.25×) as the board creeps and snaps to
  full brightness when the grid shift promotes it to row 1. Garbage slabs render
  as a single solid bar per piece (a unit cube scaled to the slab's width ×
  height, tinted by flavor) — a smooth surface distinct from the faceted blocks —
  and carry the mottled garbage lightmap: a
  baked 64×64 luminance map (`public/textures/garbage_lightmap.png`, remapped to
  the reference's [0.85, 1.0] range) is sampled by _world_ position via an
  `onBeforeCompile` patch on the garbage material (UV = worldXY·(-1/PLAY_WIDTH) +
  0.5), so the sheen flows continuously across a slab's cells instead of tiling
  per cube. Block/garbage flavor colours in `render/palette.ts` reproduce the
  reference `block_colors`/`garbage_colors` tables. A DOM `HudView` overlay shows
  a play clock, a vertical lose bar that fills toward the safe height and tints
  green→yellow→red, and a status line (popping count, loss countdown, game over)
  — presentation thresholds/formatting live in the pure `view/hud.ts`. Combo
  reward signs float up on a match: the core reports `SignEvent`s (multiplier /
  magnitude / special) on an optional `SignSink` at the exact points
  `SignManager::createSign` fires — drawing no gameplay RNG, so they stay cosmetic
  — and `GameSim` buffers them for `drainSignEvents()`; `render/signsView.ts`
  spawns camera-facing sprites from the converted sign art
  (`public/textures/signs/sign_*.png`), animating the hold→fade→inflate→float life
  from the pure `view/signs.ts`. Large garbage slabs wear a decorative flavor
  decal: faithful to `GarbageFlavorImage`, `render/garbageDecalView.ts` shows one
  of four images (`public/textures/garbage/garbage_flavor_00N.png`) on a single
  slab at a time (≥4×4 cells, ~7-in-8 chance), riding it until it leaves the board;
  the eligibility/anchor/pick logic is the pure, tested `view/garbageDecal.ts`.
  A column of `LevelLights` danger arrows runs down each side
  (`render/levelLightsView.ts`): one beveled 3-facet arrow per playable row,
  pointing outward, red for rows at/below the stack's `top_effective_row` and blue
  above (both sides mirror the local set, as in solo). The reference emits the
  colour; we drive the arrow's diffuse instead (lit by the headlight) for
  robustness. The red/blue rule is the pure, tested `view/levelLights.ts`. `pnpm --filter @crack-attack/client dev`. Still to come: audio.
- [~] Phase 4 (started) — **protocol messages landed** (`packages/protocol`):
  the wire surface for **input-relay lockstep**, a deliberate upgrade from the
  C++ `Communicator`'s event exchange. Both clients run _both_ sims (`GameSim`
  is instanced for exactly this) from a shared seed, advancing a tick only when
  both players' inputs for it are known; local input is scheduled `inputDelay`
  ticks ahead to hide latency. Consequences: garbage events never cross the
  wire (each client cross-wires the two sims' garbage-out ports locally), the
  status word disappears (level lights/losses are computed from the opponent's
  sim, retiring the hidden server-wins-ties quirk), and the wire carries only
  room flow (5-char room codes → Phase 5 lobby), per-tick `CC_*` input frames,
  periodic per-sim digests every `DIGEST_PERIOD` (server-compared desync
  detection), and lifecycle events the sims can't decide (concede/disconnect).
  `messages.ts` (typed union + constants), `codec.ts` (JSON now, binary later;
  strict shape/range-validating decode — semantic rules like version match and
  batch contiguity stay in server/client logic).
- [x] Phase 4 — **digest, relay server, and client netplay landed**; the
      milestone (two browsers head-to-head through the relay) is playable.
      `GameSim.digest()` (`core/digest.ts`): pure word-wise FNV-1a over every
      gameplay field — each class feeds its own words via `hashState(h)`, cosmetic
      state (death axes, pop direction/color, cosmeticRng) deliberately excluded —
      also the comparison key for the future `tools/replay-check` harness.
      `packages/server`: transport-free `RelayServer` (hello/version gate, rooms,
      ready → `match_start` with server seed + pinned player indices, verbatim
      input relay with fatal contiguity enforcement, digest comparison → `desync`,
      concede/disconnect forfeits, rematch by re-readying — the relay never learns
      gameplay outcomes, they're deterministic) + `wsServer.ts` (`ws`) + `main.ts`
      CLI (PORT/HOST, default 8080 per `CO_DEFAULT_PORT`); unit tests on fake
      connections, integration tests over real sockets, and an e2e test driving two
      real `LockstepSession`s through the relay to a shared deterministic outcome.
      `packages/client`: `net/lockstep.ts` (DOM-free) runs both sims from the match
      seed, steps only when both players' frames are known, samples local input per
      stepped tick scheduled `inputDelay` ahead (prefilled neutral), cross-wires the
      garbage ports, snapshots digests each `DIGEST_PERIOD`, and resolves the
      outcome deterministically (same-tick double loss = draw); `net/session.ts`
      wraps WebSocket+codec; `netplay.ts` renders both boards side by side with a
      room overlay, waiting indicator, and result banner (R = ready/rematch, Esc =
      concede). `?net` on the client URL enters netplay (`?relay=` overrides the
      relay URL; `pnpm --filter @crack-attack/server start` runs the relay).
- [x] Phase 5 — **lobby landed** (protocol v2): session-token identity
      (server-minted, localStorage on the client; hello with a token reclaims the
      record and any in-progress match), live `room_list` pushes with per-player
      W-L records, a full lobby screen (create / click-to-join / code fallback),
      and **reconnect grace**: a seat survives its connection — the relay keeps
      both players' full input ledgers, a mid-match drop starts a grace timer
      (`peer_dropped`, default 30 s per `CO_SERVER_TIME_OUT`), and a rejoining
      token gets `match_resume` with both histories; `LockstepSession.resume`
      replays them deterministically (no live input sampling, digests suppressed
      at/below the frontier — the server also floors replayed digests) and the
      client burns down the backlog in 500-tick chunks. Game outcomes are
      client-reported (`result`) and cross-checked; agreement records W-L through
      the abstract async `LobbyStore` (`store.ts` memory impl + `sqliteStore.ts`
      better-sqlite3; Redis-swappable — the relay only sees the interface), as do
      concessions and expired grace. `main.ts` wires SQLite via the `DB` env var
      (default `./crack-attack.db`). e2e: mid-match drop → rejoin by token →
      resume → identical deterministic outcome, zero desyncs. Deferred: best-of-3
      (`GC_GAMES_PER_MATCH`), richer rankings.
- [x] **Spectator mode landed** (protocol v3): a spectator is a third sim pair
      fed both players' input streams — `net/spectator.ts` (DOM-free
      `SpectatorSession`: same garbage cross-wiring, per-stream contiguity,
      steps only fully-buffered ticks, identical deterministic outcome). The
      relay attaches watchers to waiting or playing rooms (`spectate` →
      `spectate_joined` + `spectate_start`; mid-match joins ship both ledgers —
      the `match_resume` mechanism reused), fans both `peer_inputs` streams and
      all match lifecycle to them, pushes `spectators` rosters (watchers are
      live and visible by name, per design), and closes evaporated rooms with
      `room_closed`. Lobby room list shows watcher counts + a watch button; the
      watch view titles the boards "A vs B", catches up in chunks, and stays
      seated across rematches (Esc leaves). e2e: a mid-match watcher catches up
      and lands bit-identical sims and the same outcome as the players.
- [x] **Phase 3 AI landed** (two flavours). The reference's gridless
      `ComputerPlayer` (timed garbage machine) is ported faithfully in
      `core/computerPlayer.ts` (+ `GarbageQueue`, Easy/Medium/Hard cadences and
      loss heights) and kept for parity, but the _visible_ opponent is a real
      grid-playing bot: `core/aiController.ts` `AiController.decide(sim)` reads
      the board + swap cursor each tick and returns the next `ActionState` — a
      pure, deterministic function of sim state plus its own tiny plan/timer (no
      clocks, no RNG). It picks the nearest single swap that completes a 3+ run
      (re-evaluated every action tick so the rising board never leaves it
      chasing a stale target), walks the cursor there pulsing presses (the
      Swapper debounces held keys), and swaps; medium also "digs" blocks into
      gaps to churn up matches. **Hard is strategic**: rather than greedily
      clearing every 3 (a plain 3-match sends _no_ garbage), it look-ahead-plans
      via a pure cascade evaluator (`core/aiPlanner.ts` — apply a candidate swap
      to a lightweight board copy, settle gravity, remove 3+ runs, repeat;
      counts chain depth ≈ multiplier, cleared ≈ magnitude, garbage shattered),
      and _banks_ small clears while safe, firing only chains / 4+ combos /
      garbage shatters (what actually attack), dropping to survival clears when
      the stack tops out. Measured: easy is the survival floor (fixing an
      earlier inversion), and attack output escalates easy<medium<hard (hard
      throws far more garbage). All tiers stay a pure, deterministic function of
      sim state (no clocks, no RNG), ~29µs/decide.
      **Solo vs AI** (`client/aiMatch.ts`): two _visible_ real boards — you left,
      the bot's `GameSim` right — cross-wired through the garbage seam exactly
      like netplay, driven by `AiController.decide`; full view stack + countdown + celebration + audio, entered via a difficulty picker from the solo
      screen. **Netplay vs AI** (protocol v4, deterministic _client-side seat_):
      a room may seat a bot instead of a second human (`create_room.aiOpponent`);
      the bot's inputs never cross the wire — every client and spectator
      regenerates them locally by running the same `AiController` over the
      lockstep-identical AI sim, so `match_start`/`spectate_start` carry only an
      `aiOpponent` descriptor (difficulty + seat index; the AI sim reuses the
      match seed and the controller is RNG-free). `LockstepSession`/
      `SpectatorSession` grow an optional `AiSeat`: they synthesize the bot's
      frame each tick just-in-time (never stalling on it, no digests to compare),
      and the relay hosts the "1 human + 1 bot" room (single-ready start, human
      result accepted directly, human drop tears the room down — no grace/resume
      for bots, not persisted to W-L). A "vs AI" lobby button opens the picker;
      spectators see the identical AI moves. Tested: controller play/determinism/
      reset, a spectator reproducing both boards _and_ the AI from only the human
      stream (bit-identical digests), and the full relay AI-room flow.
- [x] **AI-vs-AI arena landed** (`tools/ai-arena`): a headless, deterministic
      match runner for measuring AI changes instead of eyeballing them — two
      seeded `GameSim`s (identical boards; seats near- but not exactly
      symmetric since A steps first and enqueues draw the receiver's RNG —
      `--both` replays seeds with seats swapped), garbage
      ports cross-wired as in netplay, each driven by its own `AiController`;
      `(tuningA, tuningB, seed)` fully determines a result (same-tick double
      loss = draw; tick cap = distinct `timeout`). Every behavioural knob is now
      the exported `AiTuning` struct (`core/aiController.ts`; the named tiers
      are presets via `aiTuningFor`, behaviour unchanged), and the CLI pits
      presets or JSON override files over reproducible seed ranges
      (`node tools/ai-arena/dist/cli.js --a cand.json --b hard --seeds 50`),
      reporting W/L/draw, avg length, and garbage throughput. Original
      baselines (seeds 1–20): medium sweeps easy 20-0; hard beat medium only
      11-9 and dropped 6/20 to easy (fixed by the defensive planning below —
      the `dangerMargin` 3→5 "fix" those baselines suggested is now strictly
      worse, 9-19 against current hard: the tension was a symptom of missing
      defense, not a real trade).
- [x] **Defensive garbage planning landed** (hard tier): the bot now _remodels
      the board to shatter garbage_ instead of only taking one-swap shatters.
      Probing showed the fire branch alone left slabs sitting (garbage usually
      perches on the tallest column, where no row has 3 of a colour), so
      `core/aiPlanner.ts` gains two pure planners.
      `planShatterSetup(board, maxCost)`: the cheapest sequence of _lateral_
      block↔block swaps (gravity-neutral — column occupancy never changes, so
      plans are stable and re-planning each action tick converges; each executed
      swap reduces cost by exactly 1) assembling a 3-run in a garbage-adjacent
      window, in either orientation — horizontal (three same-colour sources shuttled
      along one row segment; minimal-cost subset guarantees no matching-blocks no-op
      swap) or vertical (each row laterally supplies its _nearest_ matching
      block — far more often available). The run-completing swap is left to
      the existing fire branch (its cascade shows `garbageShattered > 0`).
      `planUndermine`: when no setup reaches the slab, dig its load-bearing
      support blocks (contiguous blocks capped by garbage) sideways into
      fall-through gaps so the slab descends onto the wider stack, where
      setups exist; strictly decreasing potential energy ⇒ always terminates.
      Strategic priority: fire → danger-clear → shatter setup → undermine →
      bank. New `AiTuning` knobs: `shatterSetupMaxCost` (default 10; 0
      disables), `undermine`. Measured (arena): new hard beats old hard 19-1;
      vs medium 11-9 → 16-4 (18-12 on fresh seeds 21–50); vs easy 14-6 → 18-2
      (27-3 fresh) — while _increasing_ attack throughput (shattered slabs
      feed combos). Tests: window/orientation unit tests incl. plan-execution
      convergence to a shattering swap and progress guarantees.
- [x] **Offensive chain building landed** (hard tier): the bot now _builds_
      chains instead of merely noticing them. `planChainSetup`
      (`core/aiPlanner.ts`): a bounded two-ply search for one gravity-neutral
      block↔block **setup swap** that fires nothing itself (a swap that clears
      is a clear, owned by the fire branch) but _enables_ a worth-firing
      cascade one trigger swap later, scored by `attackValue` + shatter bonus.
      A static `makesRun3` prefilter — exact for a cascade's first round on a
      settled board — gates the full cascade evaluation, so only genuine
      trigger candidates (plus block-into-gap drops, which trigger via
      gravity) pay for `evaluateSwap`; after JIT warm-up decide() worst-cases
      ~400µs, avg ~32µs. The enabled trigger meets the fire branch's own
      thresholds, so it is guaranteed to be taken on a later action tick —
      and re-planning then either fires or finds a _further_ enabler, so
      multi-swap constructions emerge from repeated one-swap planning.
      Priority: replaces generic clustering as the preferred bank move (safe
      state only, after all defense). New `AiTuning` knob: `chainSetup`.
      Measured (arena): beats chainSetup-off hard 14-6 (seeds 1–20); vs
      medium 16-4 → 15-5 (seeds 1–20) and 18-12 → **24-6** on fresh seeds
      21–50 (68% → 78% combined); vs easy 18-2 → 19-1 with kills ~25% faster
      (86s → 66s avg); attack throughput roughly doubled (0.17 → 0.30-0.40
      cells/s).
- [x] **Fire-threshold sweeps + trigger timing measured** (negative results,
      documented so they aren't retried): `fireMinChain` 3 is a wash vs 2
      (14-15-1) and `fireMinRun` 5 clearly loses to 4 (8-22) — 2-chains and
      4-combos are worth firing immediately; tempo is king. Trigger timing
      (hold a ready non-shattering fire while an opponent slab is about to
      land, then fire _through_ it) is implemented behind new `AiTuning` knobs
      — `holdFireTicks`, `holdFireMinCells`, fed by
      `GarbageGenerator.pendingCellsWithin` (own-queue inspection; lockstep-
      safe, `AiSimView` grew `clock` + `garbageGenerator`) — but measured
      neutral-to-negative head-to-head (16-19-25 combined; 40-tick and
      12-cell variants within noise), so it defaults **off**
      (`holdFireTicks: 0`). Why it fails: slabs land on _top_ of the stack
      while cascades match deep inside it, so a held fire rarely reaches the
      fresh slab, and holding costs tempo. The knobs stay for future timing
      experiments.
- [x] **Multi-enabler lookahead + smooth tier ladder landed**. Probing showed
      only 13% of bank positions have a single chain enabler, and 22% of the
      rest have a _two-setup_ construction — so `planChainSetup` gains a
      second level (`AiTuning.chainLookahead`): when no single enabler
      exists, scan setup swaps whose result contains one (setup → setup →
      trigger; the monotone ladder still guarantees progress). Costs ~0 in
      play because chain planning is board-pure and now memoized by
      `hashPlanBoard` in the controller (pure optimization — decisions
      identical, lockstep safe; the memo also un-did a 5× decide() slowdown
      the deeper search initially caused). Measured _neutral on win rate_
      (29-28-3 vs lookahead-off; 23-7 vs 24-6 against medium) with a mild
      tempo gain (~8% faster kills, +11% throughput) — kept ON for tempo and
      because the bot visibly builds instead of shuffling in quiet stretches.
      **Medium is now strategic-lite** (fires the chains/combos/shatters it
      sees, survival-clears in danger, undermines garbage towers; no shatter
      setups, no chain building; `strategic: false` restores the old digger
      for experiments): arena-tuned over four candidate presets to land both
      ladder gaps — hard > medium 77% (46-14, seeds 1–60), medium > easy 93%
      (28-2; was a degenerate 20-0), and medium out-attacks the old digger 3×
      (0.26 vs 0.09 cells/s), beating it 18-12. Next candidates: easy-tier
      calibration vs new players, best-of-N arena mode.
- [ ] Phase 6 stretch (X-mode, replays, WebRTC, binary codec if
      measurements demand it)

See `BROWSER_PORT_PLAN.md` for the full phase breakdown and suggested order of work.

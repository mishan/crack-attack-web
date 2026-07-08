# Browser Port Plan — Crack Attack! → TypeScript / Three.js

Decisions this plan assumes: **faithful tick-for-tick port** of the game rules, **TypeScript throughout** (shared core between browser and Node), **Three.js** rendering to recreate the 3D look, **server-relayed lockstep** over WebSocket with a lobby server.

## Guiding principle

The C++ codebase already separates what matters: all game rules are integer arithmetic on `Grid` state, driven at a fixed 50 Hz, with randomness from a single seeded source. Rendering, input, audio, and transport are platform layers. The port strategy is to translate the rules layer *mechanically* — same constants, same tick order, same integer math — and rewrite the platform layers idiomatically for the web. Faithfulness is verified by replay comparison against the C++ build, not by eyeballing.

One deliberate architectural departure: the C++ code uses static classes as singletons, so only one simulation can exist per process. The port wraps all simulation state in a `GameSim` object. This is required anyway for AI games (opponent sim), server-side verification, replays, and tests running in parallel — and it changes nothing about the logic.

## Repo layout

```
packages/
  core/      # deterministic simulation — zero dependencies, runs in browser & Node
  protocol/  # message types + encoding shared by client and server
  client/    # Three.js renderer, input, HUD, audio (Vite app)
  server/    # lobby + lockstep relay (Node, ws)
tools/
  replay-check/   # golden-master harness comparing core vs C++ replays
  obj2gltf/       # one-time asset conversion scripts
```

pnpm workspaces, Vitest, ESLint/Prettier. `core` and `protocol` must never import DOM or Node APIs.

---

## Phase 1 — Deterministic core (`packages/core`)

The heart of the project; everything else hangs off it. Port these units, in roughly dependency order:

1. **Constants** — transcribe `Game.h` verbatim into `constants.ts`. Key values the whole sim hangs on: grid 6×45 (`GC_PLAY_WIDTH`/`GC_PLAY_HEIGHT`), safe height 13, 50 steps/sec, 60 subdivisions per grid cell (`GC_STEPS_PER_GRID`), fall velocity 20, swap velocity 10 (→ 6-step swap), hang delay 3, dying delay 90, pop delays 50+15/15/50, move delay 6, creep delay 1200 with +20 timer step every 500 ticks capped at 2400, loss delay 350 ticks (7 s) after safe-height violation, garbage drop delay 300±40, max garbage height 11, garbage queue size 8, min pattern length 3.
2. **PRNG** — `Random.cxx` wraps libc `srand()/rand()`. Implement glibc's `random()` additive-feedback algorithm (TYPE_3, well documented) in TS so a seed produces the identical sequence the Linux C++ build sees. This is what makes replay validation possible; it also ships fine as the production PRNG. Audit every `rand()` call site in gameplay code (creep row generation, block colors, special-block chance, garbage flavors, X-mode wilds) and match call order exactly — determinism is about *sequence position*, so even one extra draw desyncs. Caveat discovered in the source: cosmetic systems (`SparkleManager` — 23 call sites, `CelebrationManager`, `SignManager`, `WinRecord`) draw from the *same* `rand()` stream as gameplay (`BlockManager`, `Grid`, `GarbageGenerator`, `GarbageManager`, `X`). The port should give cosmetics a separate, unsynced PRNG — but this means sequence-exact validation against unmodified C++ is impractical; see the log-based approach below.
3. **Grid + Block/Garbage stores** — `Grid`, `BlockManager`, `GarbageManager`, `Garbage`, `Block`. Fixed-size stores and integer state flags translate directly (use typed arrays / plain objects; no allocation during play). Preserve the element state flags (`GR_EMPTY/BLOCK/GARBAGE/FALLING/IMMUTABLE/SHATTERING/HANGING`) and the check-registry → `ComboTabulator` linkage.
4. **Swapper, Creep** — swap/move timing; row rise speed curve, new-row generation (this is RNG-order-critical), manual advance, safe-height violation and the loss countdown.
5. **Combos → garbage** — `ComboTabulator`, `ComboManager`, `GarbageGenerator`, `GarbageQueue`: pattern magnitude and chain multipliers → garbage dimensions/flavors, drop delays, and the outbound "garbage event" interface. This interface is exactly what netcode and AI plug into — keep it as a port on `GameSim`: `onGarbageOut(events)` / `receiveGarbage(event)`.
6. **Tick driver** — `GameSim.step()` replicating `Game::timeStep()`'s manager call order exactly (order is gameplay-relevant), including the `awaking_count`/`dying_count` gating. Wall-clock accumulation stays *outside* the sim: callers feed it whole ticks.
7. **Controller abstraction** — the sim consumes an `ActionState` snapshot per tick (left/right/up/down, swap, advance), mirroring `Controller`. Input devices are the caller's problem.
8. **ActionRecorder equivalent** — record/replay `(tick, actions)` streams from day one; it's the test harness, the desync debugger, and eventually a replay feature.

Defer X-mode (`X.cxx` wilds/invisibility) to a later phase; it hooks into blocks and garbage but is cleanly flagged by `CM_X`.

### Verifying faithfulness

- Instrument the C++ build (`--enable-debug`) to dump a per-tick digest — hash of grid contents + swapper position + score — and to accept a fixed seed. It already has `ActionRecorder` (CM_REPLAY) for the input side. Because cosmetics share the C++ RNG stream (see above), also log each *gameplay* RNG draw with a call-site tag; the TS core validates by consuming the logged draws in order rather than by cloning glibc's generator. (Implementing glibc `random()` in TS then becomes optional rather than load-bearing.)
- `tools/replay-check` runs the same seed + action stream through the TS core and diffs digests tick by tick. First divergence pinpoints the buggy system.
- Record a corpus of real games (solo, garbage-heavy, near-loss) as golden masters in CI.
- Property tests on the core: no floats in state, step(state) is pure given (state, actions, RNG), serialize→deserialize→step equivalence.

## Phase 2 — Client shell (`packages/client`)

- **Assets**: original `.obj` sources exist in `data/models/` — convert once to glTF (`tools/obj2gltf`); do *not* transcribe the generated `obj_*.cxx` files. Textures in `data/` are PNG/TGA; convert TGA → PNG. GPL v2 covers the assets — keep the port GPL-compatible.
- **Scene**: recreate camera, lighting, and layout from the constants in `Displayer.h`; one `BoardView` per player. Blocks/garbage/swapper as instanced meshes.
- **Loop**: `requestAnimationFrame` renders; sim ticks at 50 Hz from accumulated time (same accumulator pattern as `Game::timeStep`). Render interpolates positions between ticks — the sim's 60-subdivision positions make this easy.
- **Input**: keyboard mapping mirroring `Controller` (arrows + swap + advance), rebindable. Touch controls deferred.
- **HUD**: countdown, clock, score, level lights, lose bar, message signs — all have direct counterparts in the `Draw*.cxx` / manager files; port behavior, restyle freely.
- Milestone: **playable solo game in the browser** that passes replay checks against C++.

## Phase 3 — AI opponent

Port `ComputerPlayer`/`ComputerPlayerAI`. Note it does **not** simulate a grid — it's a timed state machine that fabricates garbage sends and decides its own loss based on queued garbage height, with per-difficulty timing parameters. It plugs into the same garbage in/out port as the network path. Cheap to port, gives single-player depth immediately. Local score records in `localStorage` (replacing `~/.crack-attack/`).

## Phase 4 — Multiplayer (server-relayed lockstep)

The original's netcode surface is tiny and worth keeping conceptually: both sides run identical sims from a shared seed; every 32 ticks (`CO_COMMUNICATION_PERIOD`) they exchange only (a) queued garbage events `{time_stamp, height, width, flavor}` and (b) a status word `{level_lights, game_state, loss_time_stamp, sync}`. The opponent's board is rendered from your *local* sim of them fed by these events — no state transfer.

Changes required for the browser:

- **Transport**: WebSocket to the relay server, ordered+reliable, which subsumes ENet's reliable channels. Define messages in `packages/protocol` (compact JSON first; binary later only if measurements demand it).
- **No blocking**: the C++ sides literally block on alternating send/recv each period. Browsers can't. Replace with: each peer sends its period-N packet as soon as tick 32·N completes; the sim may run ahead until it *needs* period-N data from the opponent (garbage insertion time or period N+1 boundary — whichever is stricter), then stalls with a "waiting for opponent" indicator. This is standard lockstep buffering and preserves determinism exactly.
- **Handshake** (server-mediated, replacing the original version-string/X-flag/name/texture/seed exchange): lobby server assigns the match, generates the seed, and forwards protocol version, mode flags, and player names. Custom garbage-flavor image exchange (the original sends raw texture bytes) is deferred.
- **Sync/pause/loss**: keep the sync-counter scheme (`Game::syncPause`) for pauses; keep loss resolution by comparing `loss_time_stamp` (original quirk: client loses ties — with a relay, let the server arbitrate instead).
- **Desync detection** (improvement over the original): include the per-tick state digest from Phase 1 in each status message; the relay or peers compare and surface desyncs immediately instead of letting boards silently diverge.

Milestone: two browsers playing head-to-head through the relay.

## Phase 5 — Lobby

Node/TS server (`packages/server`), same process as the relay initially: named players (lightweight auth — start with display names + session tokens), room list, create/join/ready flow, seed generation, match lifecycle (best-of-3 per `GC_GAMES_PER_MATCH`), reconnect grace using the lockstep buffer, and basic rankings/W-L records in SQLite. Spectating falls out almost free later: a spectator is a third sim fed both players' event streams.

## Phase 6 — Stretch

X-mode (extreme variant), shareable replays (seed + action streams are tiny), touch/mobile controls, spectator mode, WebRTC data channels as a latency upgrade (relay stays for signaling and fallback), custom garbage flavor images.

## Risks / open questions

- **RNG call-order drift** is the #1 desync source in a faithful port; the tick-digest harness exists to catch it early. Build it before porting `Creep`.
- **Hidden float math**: audit the C++ gameplay path for floats leaking into state (`Sine` tables and springs are display-only, but verify Score and X-mode). Floats in sim state would threaten cross-browser determinism; keep sim state integer-only.
- **glibc `random()` fidelity**: only relevant if pursuing seed-clone validation; the RNG-draw-log approach above sidesteps it and is the recommended path given the shared cosmetic/gameplay stream.
- **Asset conversion quality**: the `.obj` models are early-2000s low-poly; decide per-model whether to convert or remodel.
- **Licensing**: the original is GPL v2; a faithful port including converted assets should be released GPL-compatible.

## Suggested order of work

Phase 1 items 1–2 + the C++ digest instrumentation first (the validation harness pays for itself immediately), then Grid → Swapper/Creep → combos/garbage → tick driver, each landing with replay tests. Phase 2 can start against a partial core (render a grid before garbage exists). Phases 3 and 4 are independent of each other once the core's garbage port is stable; do AI first — it makes the game fun while the netcode is under construction.

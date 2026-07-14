# Crack Attack! (web)

A browser port of [Crack Attack!](https://www.nongnu.org/crack-attack/) — a GPL
clone of Tetris Attack — from C++/OpenGL to TypeScript. It runs the same
real-time block-matching game in the browser with Three.js rendering and
server-relayed lockstep multiplayer plus a lobby, plus solo play and an AI
opponent.

The project is a pnpm monorepo:

| Package             | What it is                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `packages/core`     | Deterministic simulation — zero deps, runs in the browser and Node. |
| `packages/protocol` | Wire message types + codec shared by client and server.             |
| `packages/client`   | Three.js renderer, input, HUD, audio (a Vite app).                  |
| `packages/server`   | Lobby + lockstep relay (Node, `ws`, SQLite).                        |
| `tools/`            | Dev tooling: `ai-arena`, `replay-check`, `obj2gltf`.                |

## Requirements

- **Node** `^20.19.0 || >=22.12.0`
- **pnpm** `9.x` — the repo pins it via the `packageManager` field, so the
  simplest way to get the right version is Corepack (bundled with Node):

  ```sh
  corepack enable
  ```

  After that, `pnpm` in the repo root uses the pinned version automatically. (If
  you can't enable Corepack, `npm i -g pnpm@9` works too.)

## Install

```sh
pnpm install
```

## Everyday commands

Run these from the repo root; they operate across all packages.

```sh
pnpm build          # compile everything (tsc -b, project references)
pnpm test           # run the test suite once (Vitest)
pnpm test:watch     # watch mode
pnpm typecheck      # type-check without emitting (tsc -b)
pnpm lint           # eslint .
pnpm format         # prettier --write .
pnpm format:check   # prettier --check .
pnpm clean          # tsc -b --clean
```

Tests are co-located with the source as `*.test.ts`. To run a single file:

```sh
pnpm exec vitest run packages/core/src/aiController.test.ts
```

## Run the client (solo, in the browser)

```sh
pnpm --filter @crack-attack/client dev
```

Vite serves the app (default <http://localhost:5173>). Solo play works entirely
in the browser with no server. From the solo screen you can also start a **Play
vs AI** match or switch to **Play online** (netplay — needs the relay, see
below).

Controls:

- **← → ↑ ↓** move the cursor · **Z** / **Space** swap · **X** raise the stack
- **R** restart (solo) / ready-rematch (netplay) · **P** pause (solo) · **M** mute
- **Esc** concede / stop watching (netplay)

### Production build

```sh
pnpm --filter @crack-attack/client build     # outputs to packages/client/dist/web
pnpm --filter @crack-attack/client preview    # serve the built bundle locally
```

The app must be served over HTTP(S) — opening `dist/web/index.html` directly via
`file://` won't load ES modules. Use `dev`/`preview`, or host `dist/web` behind
any static file server.

### Client URL parameters

Append these to the client URL (e.g. `http://localhost:5173/?net`):

- `?net` — boot straight into netplay instead of solo.
- `?relay=<url>` — override the relay WebSocket URL for this session, e.g.
  `?relay=ws://localhost:8080` or `?relay=wss://example.com/ws`.
- `?tune` — open the lighting/material render tuner (dev aid).

## Run the relay server (for multiplayer)

Netplay and spectating go through the relay. Build it once, then start it:

```sh
pnpm --filter @crack-attack/server build
pnpm --filter @crack-attack/server start
```

It listens on **:8080** by default and prints the address it bound to. The relay
forwards input frames, assigns rooms/seeds, compares digests, and persists
win/loss records — it never runs the simulation itself.

### Server environment variables

| Var    | Default             | Meaning                                                            |
| ------ | ------------------- | ------------------------------------------------------------------ |
| `PORT` | `8080`              | TCP port. Base-10 integer `0..65535`; `0` lets the OS pick a port. |
| `HOST` | all interfaces      | Interface to bind (e.g. `127.0.0.1` for local-only).               |
| `DB`   | `./crack-attack.db` | SQLite file for identities/records. Use `:memory:` for ephemeral.  |

Examples:

```sh
# Local-only relay on a custom port, no persistence:
PORT=9000 HOST=127.0.0.1 DB=:memory: pnpm --filter @crack-attack/server start

# Persist records to a specific file:
DB=/var/lib/crack-attack/lobby.db pnpm --filter @crack-attack/server start
```

## Wiring the client to the relay

The client resolves the relay WebSocket URL in this priority order:

1. **`?relay=<url>`** URL parameter (per-session override; handy in dev).
2. **`VITE_RELAY_URL`** — baked in at build time (the deployment story).
3. **Fallback**: the same host as the page, on port `8080`, with the scheme
   following the page's security context (an `https://` page uses `wss://`, an
   `http://` page uses `ws://`).

`VITE_RELAY_URL` is a Vite env var (any `VITE_`-prefixed variable is exposed to
the app). Set it for a dev session or a production build:

```sh
# Dev, pointing at a relay elsewhere:
VITE_RELAY_URL=ws://localhost:8080 pnpm --filter @crack-attack/client dev

# Production build baking in a deployed relay (e.g. behind a wss reverse proxy):
VITE_RELAY_URL=wss://example.com/ws pnpm --filter @crack-attack/client build
```

You can also put it in a `packages/client/.env` file (`VITE_RELAY_URL=...`).

### Local multiplayer test

1. Start the relay: `pnpm --filter @crack-attack/server start`
2. Start the client: `pnpm --filter @crack-attack/client dev`
3. Open the client, click **Play online**, and **Create room** — share the
   5-character room code (or click the room in the lobby list) from a second
   client to join. A third client can **watch** any room.

Identity is stored per browser origin (a session token in `localStorage`), so to
play a human-vs-human match on one machine, use **two different browsers** or a
**private/incognito window** for the second player — otherwise both tabs share
the same identity. Playing **vs AI** needs only one client.

### Playing vs AI

The AI opponent plays a real, visible board (not a scripted attacker). Choose a
difficulty (Easy clears matches on sight, Medium digs to churn up matches, Hard
plans combos and chains to attack):

- **Solo:** the **Play vs AI** button on the solo screen — two boards side by
  side, you vs the bot.
- **Netplay:** the **vs AI** button in the online lobby seats a bot instead of a
  second human. The bot is deterministic and computed identically on every
  client, so spectators see the same moves.

## Tools

Under `tools/` (see `tools/README.md` for more):

- **`ai-arena`** — a headless, deterministic AI-vs-AI match runner for measuring
  AI changes. After `pnpm build`:

  ```sh
  node tools/ai-arena/dist/cli.js --a candidate.json --b hard --seeds 50
  ```

  `--a`/`--b` take a preset name (`easy`/`medium`/`hard`) or a JSON tuning-override
  file; `--seeds N` runs a reproducible range; `--both` replays each seed with the
  seats swapped.

- **`replay-check`** — golden-master digest harness (core vs the C++ reference).
- **`obj2gltf`** — one-time Wavefront OBJ→glTF asset conversion.

## The C++ reference

We port from the original C++ Crack Attack! as the reference implementation:
<https://github.com/gnu-lorien/crack-attack>. It isn't needed to build or run
this port — it's used to port from and to validate against. See `CLAUDE.md` for
the port status and architecture notes, and `BROWSER_PORT_PLAN.md` for the phase
plan.

## License

GPL-2.0-or-later. The original Crack Attack! is GPL v2; this port and any
converted assets are kept GPL-compatible. See `COPYING`, and
`packages/client/public/AUDIO_COPYRIGHT.txt` for audio-asset provenance.

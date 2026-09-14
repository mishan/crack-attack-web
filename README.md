# Crack Attack! (web)

A browser port of [Crack Attack!](https://www.nongnu.org/crack-attack/) — a GPL
clone of Tetris Attack — from C++/OpenGL to TypeScript. It runs the same
real-time block-matching game in the browser with Three.js rendering and
server-relayed lockstep multiplayer plus a lobby, plus solo play and an AI
opponent.

![AI vs AI Demo Mode](docs/images/screenshot.png)

**Play it: [c-a.foggyden.org](https://c-a.foggyden.org/)** — solo, against the
AI, or in the multiplayer lobby. Or just watch: the AI-vs-AI demo mode plays
itself.

The project is a pnpm monorepo:

| Package             | What it is                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `packages/core`     | Deterministic simulation — zero deps, runs in the browser and Node. |
| `packages/protocol` | Wire message types + codec shared by client and server.             |
| `packages/client`   | Three.js renderer, input, HUD, audio (a Vite app).                  |
| `packages/server`   | Lobby + lockstep relay + solo scoreboard (Node, `ws`, SQLite).      |
| `tools/`            | Dev tooling: `ai-arena`, `replay-check`, `obj2gltf`.                |

## Requirements

- **Node** `>=22.13.0` (the relay uses Node's built-in `node:sqlite`)
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

Solo runs can also compete on the online high-score boards the relay hosts
(see [Solo scoreboard](#solo-scoreboard)):

- With **Ranked: on** (the default), each game starts from a server-issued
  seed. At game over the run is submitted, then verified and ranked by the
  server.
- The first ranked game over asks for the name shown on the boards
  (prefilled with your lobby name), or lets you skip submitting that run.
- The HUD shows `RANKED`, `PRACTICE`, or why a run is unranked, then the run's
  monthly and all-time place.
- Pausing a ranked run hides the board.
- **High scores** opens the boards.
- If the relay can't be reached, solo still plays, just unranked. A finished
  run waits and is sent later.

Controls:

- **← → ↑ ↓** move the cursor · **Z** / **Space** swap · **X** raise the stack
- **R** restart (solo) / ready-rematch (netplay) · **P** pause (solo) · **M** mute
- **Esc** concede / stop watching (netplay)
- Music starts **off** (sound effects are on); turn it up with the ♪ slider at
  the top right, and the setting is remembered.

### Production build

```sh
pnpm --filter @crack-attack/client build     # outputs to packages/client/dist/web
pnpm --filter @crack-attack/client preview    # serve the built bundle locally
```

The app must be served over HTTP(S) — opening `dist/web/index.html` directly via
`file://` won't load ES modules. Use `dev`/`preview`, or host `dist/web` behind
any static file server. To put the game on a server of your own, see
[Deploying](#deploying).

### Client URL parameters

With no parameters the game opens in attract mode, like an arcade cabinet: the
title card, then hard-vs-hard AI matches that play until you press a key or
click, which starts a solo game.

Append these to the client URL (e.g. `http://localhost:5173/?net`):

- `?solo` — skip attract mode and boot straight into solo play.
- `?net` — boot straight into netplay instead.
- `?scores` — open the online high-score boards.
- `?demo` — boot straight into the AI-vs-AI demo with its viewer controls
  (hard vs hard); `?demo=easy,hard` picks the left and right bots. Handy as a
  showcase link.
- `?relay=<url>` — override the relay WebSocket URL for this session, e.g.
  `?relay=ws://localhost:8080` or `?relay=wss://example.com/ws`.
- `?tune` — open the lighting/material render tuner (dev aid).

## Run the relay server (for multiplayer and the scoreboard)

Netplay, spectating and ranked solo runs go through the relay. In development, build it once,
then start it from the repo (to deploy it, see [Deploying](#deploying)):

```sh
pnpm --filter @crack-attack/server build
pnpm --filter @crack-attack/server start
```

It listens on **:8080** by default and prints the address it bound to. The relay
forwards input frames, assigns rooms/seeds, compares digests, and persists
win/loss records — it never runs a netplay simulation itself. The same port
also serves the [solo scoreboard](#solo-scoreboard), the one place the server
does run the game: to verify submitted runs.

Abuse limits: incoming WebSocket messages are capped at **16 KiB** (the largest
legitimate one is under 1 KiB; ws closes an offending connection with code
1009), and a player whose input stream outruns real time by more than ~2 s or
exceeds the per-match ledger cap is disconnected like any protocol violation.
Background store failures (e.g. a busy SQLite file when recording a forfeit)
are logged to stderr and the relay keeps serving.

### Server environment variables

| Var           | Default             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`        | `8080`              | TCP port. Base-10 integer `0..65535`; `0` lets the OS pick a port.                                                                                                                                                                                                                                                                                                                                                    |
| `HOST`        | all interfaces      | Interface to bind (e.g. `127.0.0.1` for local-only).                                                                                                                                                                                                                                                                                                                                                                  |
| `DB`          | `./crack-attack.db` | SQLite file for identities, records and the solo scoreboard. Use `:memory:` for ephemeral.                                                                                                                                                                                                                                                                                                                            |
| `TRUST_PROXY` | off                 | The number of reverse proxies in front that append to `X-Forwarded-For` (`1` or `true` behind nginx alone, `2` behind a CDN and nginx); the scoreboard's rate limits then key on the client address that many entries from the right. Set it only behind proxies that set the header, and with two or more, only if the inner proxy accepts connections from the outer one alone (see [Other setups](#other-setups)). |
| `CORS_ORIGIN` | unset               | `Access-Control-Allow-Origin` for the scoreboard API, if the client is served from another origin (e.g. `https://example.com`, or `*`).                                                                                                                                                                                                                                                                               |
| `PUBLIC_URL`  | the request's host  | The game's address (e.g. `https://example.com/`), for the scoreboard's share pages: their preview image, and where they send visitors. Unset, it's the host the request came to, over `https` only if a trusted proxy says so in `X-Forwarded-Proto`.                                                                                                                                                                 |

Examples:

```sh
# Local-only relay on a custom port, no persistence:
PORT=9000 HOST=127.0.0.1 DB=:memory: pnpm --filter @crack-attack/server start

# Persist records to a specific file:
DB=/var/lib/crack-attack/lobby.db pnpm --filter @crack-attack/server start
```

### Solo scoreboard

The relay also hosts the solo high-score boards, over plain HTTP on the same
port. A ranked run starts from a server-issued ticket (a fresh seed). At game
over the client submits its replay, and the relay re-simulates it and ranks the
score _it_ computed, so a client can't claim a score it didn't play. The design
is in [`docs/SCOREBOARD_PLAN.md`](docs/SCOREBOARD_PLAN.md).

| Route                      | What it does                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `POST /api/solo/ticket`    | Issues a run ticket: `{runId, seed, simVersion, expiresAt}`.                                 |
| `POST /api/solo/submit`    | `{runId, name, replay}` → the verified score, with its all-time and monthly rank.            |
| `GET /api/solo/scores`     | A board: `board=score\|mult`, `period=all\|month`, `month=YYYY-MM`, `limit=1..100`.          |
| `GET /api/solo/replay/:id` | A run's replay.                                                                              |
| `GET /api/solo/share/:id`  | A run's share page: HTML whose link preview shows the score; it sends people on to the game. |

Limits:

- Tickets are single-use and expire after 24 h.
- A run can't be submitted sooner than it takes to play.
- Submissions are capped at 256 KiB.
- Each client address (IPv6: each /64) gets a burst of 30 tickets (then one
  every 10 s), 20 submissions (then one every 20 s), 60 board requests (then
  one a second) and 30 replay requests (then one every 2 s).
- Tickets and submissions are also limited per IPv6 /48 (tickets 120, then
  one every 2.5 s; submissions 80, then one every 5 s) and across all clients
  (tickets 600, then five a second; submissions 300, then one a second). While
  a limit shared by all clients is turning requests away, the relay logs it
  (at most every 10 minutes): if it's tickets, every player is playing
  unranked.
- A replay may change its input at most once every 3 ticks on average (plus
  100), more than anyone keeps up over a whole game.
- Board responses are cached for 5 s, so a run hidden with `admin hide` may
  show for that long (and its replay for a minute, in HTTP caches).
- Replays are verified one at a time in short slices, so a long one never
  stalls netplay. If too many are waiting, the API answers 503. Copies of a
  submission sent while it's being verified share its result.

A run's replay is kept for a week, then only if the run is among the top 100
of its month or of all time, on either board (what the boards can show). Runs
past that stay on the boards, without a replay. To take a run off the boards,
find it with `recent` and hide it. This works while the relay is running:

```sh
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin recent 50
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin hide 1234
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin unhide 1234
```

`admin` refuses a `DB` path with no database there (a typo), rather than create
an empty one. In development, run `node packages/server/dist/main.js admin …`
instead.

The client finds the API on the relay's host: `wss://example.com/ws` →
`https://example.com/api/solo`. In development the client (port 5173) and the
relay (port 8080) are different origins, so start the relay with `CORS_ORIGIN`
to play ranked runs locally:

```sh
CORS_ORIGIN=http://localhost:5173 pnpm --filter @crack-attack/server start
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

### Watching AI vs AI

**Watch AI vs AI** on the solo screen picks two bots and lets them play each
other, match after match, with a running tally — the in-browser version of the
`ai-arena` tool, and a quick way to show the game off. **N** skips to the next
match, **F** cycles 1×/2×/4× speed, **P** pauses, **Esc** leaves. No server
needed.

## Deploying

This sets up the whole game on one Linux server. nginx serves the game's files
over HTTPS and passes two paths to the relay: `/ws` for netplay and `/api/` for
the solo scoreboard. The relay runs as a systemd service and keeps its data in
one SQLite file.

HTTPS isn't optional. A page served over `https://` may only open `wss://`
WebSockets, and the relay speaks plain WebSocket, so nginx handles TLS in front
of it.

You need:

- A Linux server with systemd, and a domain name pointing at it. The examples
  use `example.com`; replace it throughout.
- On the server: Node 22.13 or newer, nginx and certbot. Node only runs the
  relay; nothing is built on the server.
- On your own machine: this repo, set up as in [Install](#install).

### 1. Build

On your machine, from the repo root:

```sh
pnpm install
pnpm --filter @crack-attack/server bundle
node packages/server/scripts/smoke-bundle.mjs
VITE_RELAY_URL=wss://example.com/ws VITE_PUBLIC_URL=https://example.com/ \
  pnpm --filter @crack-attack/client build
```

That makes the two things to copy to the server:

- `packages/server/dist/relay.mjs`: the relay, in one file. It includes the
  game and its one dependency and uses Node's built-in SQLite, so the server
  needs no `node_modules`. The smoke test runs it alone in an empty directory
  to make sure.
- `packages/client/dist/web/`: the game, as static files.

`VITE_RELAY_URL` is the address browsers use to reach the relay, fixed at build
time. The client finds the scoreboard from it: `wss://example.com/ws` →
`https://example.com/api/solo`.

`VITE_PUBLIC_URL` is the game's own address. Link previews on Facebook,
LinkedIn and the like need the game's preview image as a full URL, so the build
adds it only when this is set. Without it, shared links still work, with a
preview that has no picture.

### 2. Install the relay

Copy `relay.mjs` to the server (with `scp`, say). Then, on the server, create a
user for the relay and put the file in place:

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin crack-attack
sudo install -D -m 644 relay.mjs /opt/crack-attack/relay.mjs
```

Create `/etc/systemd/system/crack-attack.service`:

```ini
[Unit]
Description=Crack Attack! relay
After=network.target

[Service]
ExecStart=/usr/bin/node /opt/crack-attack/relay.mjs
WorkingDirectory=/opt/crack-attack
Environment=HOST=127.0.0.1 PORT=8080 TRUST_PROXY=1 DB=/var/lib/crack-attack/lobby.db PUBLIC_URL=https://example.com/
StateDirectory=crack-attack
User=crack-attack
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

- `HOST=127.0.0.1` keeps the relay's unencrypted port closed to the outside;
  only nginx reaches it.
- `TRUST_PROXY=1` tells the relay that nginx is in front. The scoreboard limits
  requests per player. Without this setting every request seems to come from
  nginx, so all players share one limit.
- `DB` is the database: player records and the scoreboard. `StateDirectory`
  has systemd create `/var/lib/crack-attack` for the relay's user, and the
  relay creates the file on first start.
- `PUBLIC_URL` is the game's address. When a player shares a ranked score,
  the link goes to a page the relay serves, and Facebook, LinkedIn and Bluesky
  show that page's preview, score included. The page uses this address for the
  preview image and to send visitors on to the game.
- If `which node` doesn't print `/usr/bin/node`, change `ExecStart` to match.

Start the relay, and have it start at boot:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now crack-attack
journalctl -u crack-attack -n 20
```

The log should end with
`crack-attack relay listening on :8080 (db: /var/lib/crack-attack/lobby.db)`.
On Node 22 there's also a one-time `ExperimentalWarning` about SQLite, which is
harmless.

### 3. Upload the game

On the server, create the directory nginx will serve, owned by your login:

```sh
sudo mkdir -p /var/www/crack-attack
sudo chown "$USER" /var/www/crack-attack
```

Then, from your machine, copy the contents of `packages/client/dist/web/` into
it:

```sh
rsync -a packages/client/dist/web/ example.com:/var/www/crack-attack/
```

### 4. Configure nginx

This config serves the game over plain HTTP for now; the next step adds HTTPS.
Save it as `/etc/nginx/sites-available/crack-attack` (on Debian and Ubuntu;
other distributions use `/etc/nginx/conf.d/crack-attack.conf`):

```nginx
server {
  listen 80;
  server_name example.com;

  # The game's files, from step 3.
  root /var/www/crack-attack;

  # Netplay: the relay's WebSocket.
  location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    # The relay doesn't send heartbeats yet, so an idle lobby connection is
    # silent. Keep it open longer than nginx's 60 s default.
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }

  # The solo scoreboard's API.
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    # Each player's address, for the scoreboard's limits (TRUST_PROXY=1).
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  # These file names change whenever their contents do, so browsers can keep
  # them for good.
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  # Always check for a new index.html, so an update shows up at once.
  location = /index.html {
    add_header Cache-Control "no-cache";
  }

  # The game's JavaScript is ~700 kB, ~185 kB compressed.
  gzip on;
  gzip_types application/javascript model/gltf+json;
}
```

On Debian and Ubuntu, enable it (the `conf.d` file needs no link), then reload
nginx:

```sh
sudo ln -s /etc/nginx/sites-available/crack-attack /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Turn on HTTPS

```sh
sudo certbot --nginx -d example.com
```

Certbot gets a free certificate from Let's Encrypt, adds HTTPS to the server
block above, and renews the certificate automatically. If it asks, have it
redirect HTTP to HTTPS.

### 6. Check it

```sh
curl -s -X POST https://example.com/api/solo/ticket    # {"runId":…,"seed":…,…}
curl -s 'https://example.com/api/solo/scores?limit=5'  # includes "total":0 until someone plays
```

Then open `https://example.com/`. The title card and an AI match should appear.
Press a key to play solo; the HUD should say `RANKED`. **Play online** should
open the lobby.

If something's wrong:

- **nginx answers 502 Bad Gateway:** the relay isn't running. Look at
  `journalctl -u crack-attack`.
- **Solo says `UNRANKED — offline`, or Play online can't connect:** check that
  the `VITE_RELAY_URL` in step 1 matches your domain, then rebuild and upload
  the game again.

### Running it

- **Logs:** `journalctl -u crack-attack`. A line starting `scoreboard:` means a
  limit shared by all players is turning requests away (if it's the ticket
  limit, everyone is playing unranked) or a background cleanup failed.
- **Moderation:** run the [admin commands](#solo-scoreboard) as the relay's
  user, so any file SQLite creates beside the database stays the relay's:

  ```sh
  sudo -u crack-attack env DB=/var/lib/crack-attack/lobby.db node /opt/crack-attack/relay.mjs admin recent 50
  ```

- **Backups:** the database is the only data to keep. Copy it with `sqlite3`
  (from the `sqlite3` package), which is safe while the relay runs; a plain
  `cp` can miss recent writes:

  ```sh
  sudo -u crack-attack sqlite3 /var/lib/crack-attack/lobby.db ".backup /var/lib/crack-attack/backup.db"
  ```

- **Stopping:** `sudo systemctl stop crack-attack` shuts the relay down
  cleanly. Rooms live in memory, so any match in progress ends.

### Other setups

- **The relay on its own host or subdomain:** build with
  `VITE_RELAY_URL=wss://relay.example.com/ws` and give that host the same
  `/ws` and `/api/` locations. The scoreboard is then on a different origin
  from the game, so add `CORS_ORIGIN=https://example.com` (the game's address)
  to the relay's `Environment=` line.
- **The game on another web server or a static host:** upload the contents of
  `dist/web` anywhere, at the domain root or in a subdirectory (asset paths
  are relative), with the caching and compression from the config above. It
  must be served over HTTP(S); opening `index.html` from disk won't load it.
  Without a relay, solo still plays, unranked.
- **A CDN in front of nginx:** set `TRUST_PROXY=2`, so the relay uses the
  address the CDN saw rather than the CDN's own. nginx must then accept
  connections only from the CDN: firewall it to the CDN's address ranges, or
  use the CDN's authenticated origin pulls. Otherwise a client could reach
  nginx directly with a made-up `X-Forwarded-For` header and pick its own
  address for the limits.

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
this port — it's used to port from and to validate against. See `AGENTS.md` for
the port status and architecture notes, and `BROWSER_PORT_PLAN.md` for the phase
plan.

## License

GPL-2.0-or-later. The original Crack Attack! is GPL v2; this port and any
converted assets are kept GPL-compatible. See `COPYING`, and
`packages/client/public/AUDIO_COPYRIGHT.txt` for audio-asset provenance.

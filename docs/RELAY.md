# The relay server

Netplay, spectating and ranked solo runs go through the relay. In development, build it once,
then start it from the repo (to deploy it, see [Deploying](DEPLOYING.md)):

```sh
pnpm --filter @crack-attack/server build
pnpm --filter @crack-attack/server start
```

It listens on **:8080** by default and prints the address it bound to. The relay
forwards input frames, assigns rooms/seeds, compares digests, and persists
win/loss records. It runs the game only to check a claim: submitted runs for
the [solo scoreboard](#solo-scoreboard), served on the same port, and disputed
netplay games. When the players' results or digests disagree, the match ends
as a desync, and the relay then replays it from the seed and both players'
inputs. If the game ended and one player reported that result, it's recorded.
If it was still in play and one player's digests were false, that player
takes the loss. Anything else records nothing. Each verdict is logged to
stderr.

Abuse limits: incoming WebSocket messages are capped at **16 KiB** (the largest
legitimate one is under 1 KiB; ws closes an offending connection with code
1009), and a player whose input stream outruns real time by more than ~2 s or
exceeds the per-match ledger cap is disconnected like any protocol violation.
Background store failures (e.g. a busy SQLite file when recording a forfeit)
are logged to stderr and the relay keeps serving.

## Server environment variables

| Var           | Default             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`        | `8080`              | TCP port. Base-10 integer `0..65535`; `0` lets the OS pick a port.                                                                                                                                                                                                                                                                                                                                                                |
| `HOST`        | all interfaces      | Interface to bind (e.g. `127.0.0.1` for local-only).                                                                                                                                                                                                                                                                                                                                                                              |
| `DB`          | `./crack-attack.db` | SQLite file for identities, records and the solo scoreboard. Use `:memory:` for ephemeral.                                                                                                                                                                                                                                                                                                                                        |
| `TRUST_PROXY` | off                 | The number of reverse proxies in front that append to `X-Forwarded-For` (`1` or `true` behind nginx alone, `2` behind a CDN and nginx); the scoreboard's rate limits then key on the client address that many entries from the right. Set it only behind proxies that set the header, and with two or more, only if the inner proxy accepts connections from the outer one alone (see [Other setups](DEPLOYING.md#other-setups)). |
| `CORS_ORIGIN` | unset               | `Access-Control-Allow-Origin` for the scoreboard API, if the client is served from another origin (e.g. `https://example.com`, or `*`).                                                                                                                                                                                                                                                                                           |
| `PUBLIC_URL`  | the request's host  | The game's address (e.g. `https://example.com/`), for the scoreboard's share pages: their preview image, and where they send visitors. Unset, it's the host the request came to, over `https` only if a trusted proxy says so in `X-Forwarded-Proto`.                                                                                                                                                                             |
| `STATS`       | off                 | `1` writes a `stats {json}` line to stderr every 10 s: event-loop delay, CPU, memory, file descriptors, traffic and backpressure, room and session counts, scoreboard queue sizes. For load tests (`tools/load-test`); it changes nothing the relay does.                                                                                                                                                                         |

Examples:

```sh
# Local-only relay on a custom port, no persistence:
PORT=9000 HOST=127.0.0.1 DB=:memory: pnpm --filter @crack-attack/server start

# Persist records to a specific file:
DB=/var/lib/crack-attack/lobby.db pnpm --filter @crack-attack/server start
```

## Solo scoreboard

The relay also hosts the solo high-score boards, over plain HTTP on the same
port. A ranked run starts from a server-issued ticket (a fresh seed). At game
over the client submits its replay, and the relay re-simulates it and ranks the
score _it_ computed, so a client can't claim a score it didn't play. The design
is in [`SCOREBOARD_PLAN.md`](SCOREBOARD_PLAN.md).

In the client:

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
  stalls netplay. They share the queue with disputed netplay games. If too
  many runs are waiting, the API answers 503; a disputed game is never turned
  away. Copies of a submission sent while it's being verified share its
  result.

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

## Accounts

Accounts are what the rated ladder ranks (the plan is in
[`RATING_PLAN.md`](RATING_PLAN.md)). An account is a handle, a key
and a rating: no email, password or real name. Registering returns a key of
eight random words the server picks, meant for a password manager. The relay
keeps only the key's SHA-256, so the key _is_ the account: there's no way to
recover a lost one. Logging in trades the key for a session, sent as
`Authorization: Bearer <session>`; sessions are stored hashed too, and last a
year from their last use. The same session logs into the lobby: `hello`
takes it in place of a guest token, and the account plays under its handle.

In the client, **Account** in the lobby opens the account screen. The key is
shown in a real login form (the handle as the username, the key as the
password), so a password manager offers to save it when **Save key** is
pressed, and fills both fields back in to log in; Copy, Download and Show
cover players without one. If the browser's own suggested password replaces
the key in that field, the form puts the key back and asks again. Logging in
from a guest session keeps the guest's token aside, and logging out returns to
it. If a relay meets the session as a guest, the client asks the account API
whether it has ended before dropping it: a relay without accounts (a dev
relay, say) doesn't log anyone out.

| Route                        | What it does                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/account/register` | `{handle, guestToken?}` → `{key, session, account}`; a guest's W-L moves over.     |
| `POST /api/account/login`    | `{key}` → `{session, account}`. Spaces or capitals in the key are fine.            |
| `GET /api/account/me`        | Session → `{account}`: handle, rating, W-L-D, and when it may next be renamed.     |
| `POST /api/account/handle`   | Session, `{handle}` → `{account}`. At most once every 30 days.                     |
| `POST /api/account/key`      | Session, `{key}` (the current one) → `{key}`: a new key. Every other session ends. |
| `POST /api/account/logout`   | Ends the session.                                                                  |
| `POST /api/account/delete`   | `{key}` → deletes the account. With a session, the key must be its account's.      |

Anything that could lose the owner the account takes the key itself, not just
a logged-in browser: a new key needs the current one, and so does deleting.
So a lost key can't be replaced either. A browser still logged in keeps
playing, but nowhere new can log in.

Handles are cleaned up like scoreboard names and unique regardless of case
and of full-width or other compatibility forms. Lookalikes across scripts (a
Cyrillic letter that looks Latin) aren't caught; rename those by hand.

Limits: each client address gets 5 registrations (then one an hour), 10
requests carrying a key (then one every 30 s) and 60 with a session (then one
a second). Registrations and key requests are also limited per IPv6 /48 and
across all clients, logged as for the scoreboard.

Moderation, by handle (typed as a player would):

```sh
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin account misha
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin rename misha "new handle"
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin hide-account misha   # off the leaderboard
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin unhide-account misha
DB=/var/lib/crack-attack/lobby.db node relay.mjs admin reset-rating misha
```

A moderator's rename doesn't count against the player's 30 days.

## Rated games

A room created **rated** seats only accounts; anyone can watch. An account
holds one seat at a time, however many browsers it's logged in on. The relay
decides every rated game itself: when one is played out, it re-simulates it
from the seed and both players' inputs and rates what really happened, whatever
the players reported. A concession is a loss at once (not during the
countdown). Leaving mid-game, or running out the reconnect grace, is a loss
too, unless the replay shows the game had already ended: a loser can't win by
leaving the winner waiting for a result that never comes. The relay also
settles a game that goes nowhere: one player's result unanswered for 30 s is
settled by replay as if both had reported, and a game with no inputs from
either side for 30 s is forfeited by whoever sent the fewest (lockstep stalls
on them). These rules apply to casual games' records too. A game the replay
can't settle isn't rated, and is logged. Ratings are Glicko-2: a new account moves fast and
settles as it plays, a rating's uncertainty grows again with days away, and a
rating is provisional (`1580?`) while that uncertainty is high. A same-tick
double loss is a draw.

To find a game, an account can press **Play rated** in the lobby and join the
rated queue. The relay pairs the two waiting players whose ratings are
closest, as long as they're within both players' windows: ±100 at first,
widening by 50 for every 10 s waited, so a quiet queue still finds someone.
Both then have 10 s to accept; whoever doesn't leaves the queue, and the other
goes back in with the time they'd waited. Two acceptances seat both in a new
rated room and start the game. **Queue again** after it goes back in the
queue, and the queue won't pair the same two again while anyone else is
waiting. The lobby shows how many are queued. The queue lives in memory: a
restart or a disconnect empties it.

A pair of accounts gets 10 rated games per UTC day, however they meet and
counting games still being settled; later games in the room are casual, and the
queue stops pairing them. Casual games still count toward an account's W-L.
Every rated game is logged with both players' ratings before and after, and with
their inputs for a week.

| Route                            | What it does                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/rating/leaderboard`    | Settled ratings with a rated game in the last 30 days, best first. `limit=1..100`. |
| `GET /api/rating/player/:handle` | An account's rating, W-L-D and last 20 rated games.                                |

`reset-rating` and `hide-account` (above) are the moderation tools; a hidden
account is kept off the leaderboard only.

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

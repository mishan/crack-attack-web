# Solo scoreboard — plan

A server-hosted high-score table for solo play, so players can compete for a
spot. Hosted by the relay (`packages/server`) alongside the lobby.

## Starting point

- Solo scoring is already a faithful port of `Score.cxx`: pure integer math in
  `packages/client/src/view/score.ts` (`ScoreState`, `scorePoints`). The flushed
  final score and top multiplier are pure functions of the `ScoreEvent` stream,
  which is a pure function of `(seed, per-tick inputs)`.
- A local hall of fame (top 30 scores, top 10 multipliers, `localStorage`) and
  a `BEST` line in the HUD already exist (`view/scoreRecords.ts`,
  `score/scoreStore.ts`).
- Solo picks its seed client-side (`generateSeed()` → `Math.random`,
  `main.ts:307`) and records no replay; only vs-AI does (`aiMatch.ts`).
- The `GameSim` is built _before_ the 3-2-1 countdown, and the board is drawn
  from that moment — so a run's seed must be known when the board is created,
  not at GO.
- The relay speaks WebSocket only (every plain HTTP request gets a 426), caps
  messages at 16 KiB, and has one table, `players(token, name, wins, losses)`,
  with no migration mechanism.
- `packages/core` is zero-dep and bundles into `relay.mjs` as-is. Headless
  `GameSim` steps ~500k ticks/s on Node, so a 10-minute game (30k ticks)
  verifies in ~60 ms.

## Trust model: server-verified replays

The client never reports a score. It submits `{runId, name, replay}`; the
server re-simulates the replay and computes the score itself.

1. **Server-issued run tickets.** Before a ranked run the client holds a
   ticket `{runId, seed, simVersion}`. Tickets are single-use and expire
   (24 h — longer than any plausible game including pauses). This stops forged
   seeds, replaying one good run many times, and submitting someone else's
   replay.
2. **Replay to the loss.** The server steps the replay in short time slices
   and accepts it only if the game ends in a loss exactly at the claimed tick.
   It stores the score and top multiplier _it_ computed.
3. **Pacing floor.** Wall time from ticket issue to submission must be at least
   `ticks / 50` seconds. This catches offline runs played faster than real time;
   it can't catch slow motion or pausing to think.
4. **What it can't stop:** a bot or tool-assisted run that sends real inputs in
   real time. The defence is that every replay is stored and publicly watchable,
   plus an admin way to hide entries.

## Ranked vs unranked runs

### When a run is ranked

A run is **ranked** only if all of these are true _when its board is created_
(new game or R restart, before the countdown):

- Ranked play is on: the player's toggle, stored in `localStorage` as
  `crack-attack.ranked`, which defaults to on.
- An unused ticket is in hand, it hasn't expired, and its `simVersion` matches
  the client build.

Otherwise the run is **unranked**, and the reason is shown:

| Reason               | HUD tag              | Cause                                                           |
| -------------------- | -------------------- | --------------------------------------------------------------- |
| Player opted out     | `PRACTICE`           | The ranked toggle is off                                        |
| Offline / relay down | `UNRANKED — offline` | The ticket request failed                                       |
| No ticket yet        | `UNRANKED — offline` | The ticket request hadn't returned by board creation            |
| Stale client         | `UNRANKED — reload`  | A deploy changed `simVersion`; reloading picks up the new build |

The seed decides the board, so a ranked run can become unranked mid-run, but an
unranked run can never become ranked.

### Getting tickets without blocking play

- The client keeps one ticket prefetched. It fetches one on page load and a
  replacement as soon as a ranked run starts. Attract mode and each game give
  that request plenty of time, so after the first game a ticket is almost
  always ready.
- The first game after a `?solo` boot creates its board as soon as the first
  ticket arrives, waiting at most ~1 s. If the ticket still hasn't come, the
  run starts unranked. This is the only wait, and it happens once per page
  load.
- With the toggle off, no tickets are fetched and the client makes no network
  calls at all.

### What changes during a ranked run

- **Pause hides the board.** Pausing a ranked run hides the board (blocks,
  garbage, level lights) behind the PAUSED overlay; the score and clock stay
  visible. Practice and unranked runs keep today's pause, with the board shown.
  The pause rules themselves don't change (no pausing during the countdown, a
  freeze, or after losing). This is only enforced in the browser: pausing doesn't
  touch the sim or the replay, so the server can't tell either way.
- **The client records the replay.** It records input _changes_ after the
  countdown gate (`main.ts:522`).
- **The HUD shows `RANKED`.**

### Opting out

- **Before a run:** turn the ranked toggle off (a solo-screen mode button next
  to Play vs AI). Every run is practice until it's turned back on.
- **During a ranked run:** turning the toggle off immediately makes the current
  run unranked. The ticket is thrown away, the HUD shows `PRACTICE`, and pause
  shows the board again. Turning the toggle _on_ mid-run only affects the next
  game.
- **Restart (R):** ends the run. Its ticket is thrown away and never submitted,
  and the next game uses the prefetched ticket. This means a player can restart
  until they like the starting board. The original allowed that too, and
  starting boards don't vary much, so we accept it. The per-IP ticket rate
  limit keeps it bounded.
- **After a loss:** nothing to decide. A ranked run is submitted automatically.
  Every run gets a row, and only the best appear in the top lists. To keep a
  run off the record, switch to practice before it ends.

### Submitting

- **Name.** The first ranked game over asks for a name before submitting,
  saved as `crack-attack.name` (the key the lobby already uses). Later runs
  submit with no prompt.
- **Outbox.** A finished run waits in a `localStorage` outbox until the server
  acknowledges it, so a network blip or a closed tab doesn't lose it. The
  outbox retries on the next page load while the ticket is still valid.
- **Result shown.** The game-over line shows "Verifying…", then the ranks
  (for example "#12 of 340 this month · #85 all time"). A rejected run shows
  "Not ranked: _reason_".
- **Local hall of fame.** It records every run, ranked or not, as it does
  today.

## Decisions

1. **Pause:** hide the board while a ranked run is paused.
2. **Board entries:** every run gets its own row, with no per-player filtering.
   Rank is the number of runs with a higher score, plus one; on a tie, the
   earlier run ranks higher. Per-IP rate limits keep one player from flooding
   the board.
3. **Time windows:** all-time and monthly (UTC calendar months). Past months
   can be requested with `month=YYYY-MM`.
4. **Identity:** left for later. No tokens are used for the scoreboard; a
   submission carries a cleaned-up name. "Your" rows are the run IDs this
   browser submitted, remembered in `localStorage`. The `user_version`
   migration step (phase 2) makes it cheap to add an identity column later.

## Phases

Each phase is one PR.

### Phase 1 — core: shared score math and solo replays (no server) — DONE

- Move `ScoreState`/`scorePoints` from `client/src/view/score.ts` to
  `core/src/scoreState.ts`. The code is already pure. Keep core free of
  top-level side effects (`"sideEffects": false`). The client imports it from
  core.
- `core/src/soloReplay.ts`:
  - **`SoloReplay` format.** `{version, seed, ticks, inputs}`, where `inputs`
    holds `[tickDelta, command]` pairs recording each input _change_. That
    keeps a long game to a few KB.
  - **`SoloRecorder`.**
  - **`verifySoloReplay(value, maxTicks)`.** Validates the replay
    (`parseSoloReplay`: shape, the tick cap, a canonical input encoding), then
    steps `GameSim` to the end, draining score events each tick
    (`runSoloReplay`). Returns `{ticks, score, topMultiplier, digest}`, or
    throws `SoloReplayError` if the replay is malformed or the game isn't lost
    exactly on its last tick.
- The client records every solo run. The game-over score it shows comes from
  the same core function the server will run. Add a "Save replay" button in
  solo.
- Tests:
  - golden fixture replays with known scores: a short one, and a longer one
    with a gray-garbage elimination and a chain of x4 or more
  - the recorder and verifier agree
  - replays that are truncated, run past the loss, or contain malformed input
    are rejected

### Phase 2 — server: HTTP API, schema and verification — DONE

- **HTTP server.** `wsServer.ts` creates the HTTP server itself and hands it to
  `WebSocketServer`, so one port serves both. WebSocket behaviour doesn't
  change; plain requests go to the scoreboard routes (`httpApi.ts`) or get a 404.
- **Shared API types.** The request/response shapes, limits, name cleanup and
  month helpers live in `protocol/src/scoreboard.ts`, for phase 3's client.

| Route                      | Purpose                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `POST /api/solo/ticket`    | Returns `{runId, seed, simVersion, expiresAt}`                                      |
| `POST /api/solo/submit`    | `{runId, name, replay}` → `{id, name, score, topMultiplier, ticks, standing}`       |
| `GET /api/solo/scores`     | `board=score\|mult`, `period=all\|month`, `month=YYYY-MM`, `limit` → ranked entries |
| `GET /api/solo/replay/:id` | The run and its stored replay                                                       |

`standing` is `{all, month}`, each `{rank, total}` on the score board.

- **Service.** `scoreboard.ts` (`SoloScoreboard`) is transport-free, like
  `RelayServer`. A submission is checked in this order:
  1. the envelope and name
  2. the replay's shape
  3. the ticket: unknown, expired, older rules, wrong seed, or submitted too
     soon
  4. re-simulation

  A ticket that fails a check is used up. A busy verifier leaves the ticket
  intact, so the client can retry. Resubmitting a run that's already recorded
  returns its standing, so the phase 3 outbox can retry safely.

- **Schema.** A `PRAGMA user_version` migration list in `sqliteStore.ts`
  upgrades existing databases in place. Version 1 adds:
  - `solo_tickets(run_id PK, seed, sim_version, issued_at)`: outstanding
    tickets only. Using one deletes it, and expired ones are swept.
  - `solo_scores(id PK, run_id UNIQUE, name, score, top_multiplier, ticks, sim_version, created_at, replay TEXT, hidden)`,
    with covering indexes for both boards and by time, so boards, counts and
    standings never read the table rows.

  A separate `ScoreStore` interface (`scoreStore.ts`) sits beside
  `LobbyStore`; `SqliteStore` implements both on one file. `recordRun` uses
  up the ticket and stores the run in one transaction. Conformance tests run
  against the memory and SQLite stores.

- **Sim version.** Core's `SIM_VERSION` identifies the rules. Tickets carry
  it, a mismatch is rejected as `stale_version`, and stored runs keep theirs.
  The golden fixture test says to bump it. Deploy the client and relay
  together.
- **Verification without a worker thread.** Core's `SoloReplayRunner` steps a
  replay a slice at a time (2000 ticks, a few ms). `SoloVerifier` runs one
  replay at a time and yields to the event loop between slices, so netplay
  input keeps flowing. A worker thread would have split the single-file
  bundle.
- **Limits:**
  - at most 32 replays queued, then 503
  - a one-hour tick cap
  - a 256 KiB body cap
  - per-client token buckets (IPv6 per /64): tickets burst 30, then 1 per
    10 s; submissions burst 20, then 1 per 20 s; board requests burst 60,
    then 1 per s
  - tickets also per IPv6 /48 (burst 120, then 1 per 2.5 s) and across all
    clients (burst 600, then 5 per s), so rotating addresses doesn't help
  - `TRUST_PROXY=<n>` takes the client from `X-Forwarded-For`, _n_ entries
    from the right (1 behind nginx, 2 behind a CDN and nginx), ports
    stripped; an entry that isn't an IP falls back to the socket address
  - `CORS_ORIGIN` for a client on another origin
- **Caching:** a board response is reused for 5 s (cleared when this relay
  records a run), and replays are served with `max-age=60`, so a hidden run
  soon drops out of caches.
- **Names:** control, format (zero-width, bidi), private-use and unassigned
  characters stripped, except a lone zero-width (non-)joiner between two
  visible characters (emoji sequences, Persian and Indic text); whitespace
  and blank-looking characters (Hangul fillers, the braille blank) collapsed
  to one space; NFC; stacked combining marks capped at two; 16 grapheme
  clusters; `bad_name` if nothing is left.
- **Moderation:** `node relay.mjs admin recent [n] | hide <id> | unhide <id>`.
  It refuses a `DB` path with no database there rather than create one.

### Phase 3 — client: ranked runs, submitting and the scoreboard screen

- Everything in [Ranked vs unranked runs](#ranked-vs-unranked-runs): the
  toggle, prefetching tickets, HUD tags, hiding the board on pause, the name
  prompt, the outbox, and the ranks at game over.
- **Scoreboard screen.** Opened from a solo-screen button or with `?scores`.
  It has Score and Multiplier tabs (like the original's two tables) and All
  time / This month / Last month tabs, highlights this browser's runs, and has
  a "watch" link on each row. New overlays call `markChrome`.
- **Attract mode.** The loop becomes title → demo match → high score table,
  like an arcade cabinet.

### Phase 4 — replay viewer

Play a stored solo replay through the solo view stack, with the demo mode's
speed and pause controls. This is the practical defence against bots, because
anyone can watch the top runs.

### Phase 5 — docs and deploy

- README: the new env vars (`TRUST_PROXY`, and `CORS_ORIGIN` if the API is on
  another host), an nginx `location /api/` block, and moderation.
- Extend `smoke-bundle.mjs` to request a ticket, submit, and read the scores.
- Add an AGENTS.md port-status entry.

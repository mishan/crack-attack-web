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

The client never reports a score. It submits `(runId, ticks, inputs)`; the
server re-simulates and computes the score itself.

1. **Server-issued run tickets.** Before a ranked run the client holds a
   ticket `{runId, seed, simVersion}`. Tickets are single-use and expire
   (24 h — longer than any plausible game including pauses). This stops forged
   seeds, replaying one good run many times, and submitting someone else's
   replay.
2. **Replay to the loss.** The server steps the replay in a worker thread and
   accepts it only if the game ends in a loss exactly at the claimed tick. It
   stores the score and top multiplier _it_ computed.
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

### Phase 1 — core: shared score math and solo replays (no server)

- Move `ScoreState`/`scorePoints` from `client/src/view/score.ts` to
  `core/src/scoreState.ts`. The code is already pure. Keep core free of
  top-level side effects (`"sideEffects": false`). The client imports it from
  core.
- `core/src/soloReplay.ts`:
  - **`SoloReplay` format.** `{version, seed, ticks, inputs}`, where `inputs`
    holds `[tickDelta, command]` pairs recording each input _change_. That
    keeps a long game to a few KB.
  - **`SoloRecorder`.**
  - **`verifySoloReplay(replay, maxTicks)`.** Validates the replay the same
    way `replay-check`'s `indexActions` does, then steps `GameSim` until the
    loss, draining score events each tick. Returns
    `{lost, ticks, score, topMultiplier, digest}`.
- The client records every solo run. The game-over score it shows comes from
  the same core function the server will run. Add a "Save replay" button in
  solo.
- Tests:
  - a golden fixture replay with a known score
  - the recorder and verifier agree
  - replays that are truncated, run past the loss, or contain malformed input
    are rejected

### Phase 2 — server: HTTP API, schema and verification

- **HTTP server.** Create it with `http.createServer` and pass `{ server }` to
  `WebSocketServer`. WebSocket behaviour doesn't change.

| Route                                        | Purpose                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /api/solo/ticket`                      | Returns `{runId, seed, simVersion}`                                               |
| `POST /api/solo/submit`                      | `{runId, name, ticks, inputs}` → `{id, rank: {all, month}, total: {all, month}}`  |
| `GET /api/solo/scores?board=&period=&month=` | Top 30 scores (`board=score`) or top 10 multipliers (`board=mult`) for the period |
| `GET /api/solo/replay/:id`                   | The stored replay                                                                 |

- **Schema.** Add a `PRAGMA user_version` migration step so existing databases
  upgrade in place. Then add:
  - `solo_runs(run_id PK, seed, sim_version, issued_at, submitted_at)`
  - `solo_scores(id PK, run_id UNIQUE, name, score, top_multiplier, ticks, created_at, sim_version, replay BLOB, hidden)`,
    indexed on `(score)` and `(created_at, score)`

  Both go behind new `LobbyStore` methods, with conformance tests against the
  memory and SQLite stores.

- **Sim version.** `simVersion` identifies the core build's rules. A change
  that breaks determinism rejects old tickets, and older scores keep their
  version label. Deploy the client and relay together.
- **Limits:**
  - a worker thread with a queue cap, so verification never delays live
    netplay
  - a tick cap on replays
  - a request body cap of about 256 KiB
  - per-IP rate limits on tickets and submissions. Behind nginx this needs a
    `TRUST_PROXY` env var so the server reads `X-Forwarded-For`; today it sees
    no client IPs.
- **Names:** trim them, strip control and zero-width characters, cap the
  length for the board, and reply `bad_name` when a name is empty afterwards.
- **Moderation:** an admin subcommand to hide an entry, e.g.
  `node relay.mjs admin hide <id>`.

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

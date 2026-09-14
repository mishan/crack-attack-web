# Backend load test plan

How to find out what one relay can carry: concurrent games, spectators per
game, lobby size, reconnect storms, and the solo scoreboard beside all of it.
The output is a capacity table with a measured knee for each dimension and a
deploy rule of thumb derived from it.

Companion to [`SCOREBOARD_SECURITY_REVIEW.md`](SCOREBOARD_SECURITY_REVIEW.md),
which covers abuse; this covers scale. The two overlap where an abusive
pattern is also the worst case for capacity (padded replays, slow readers).

## Questions to answer

1. How many concurrent human-vs-human games before input forwarding latency
   degrades, and what fails first (CPU, event loop, bandwidth, memory)?
2. How many spectators can one game carry, and how many spectators in total
   across all games?
3. How many connected lobby sessions and open rooms before room-list pushes
   dominate, and at what churn rate?
4. What does a long match cost (ledger memory, late-join size), and what
   does a reconnect storm cost?
5. How much scoreboard traffic can run alongside netplay without netplay
   noticing?
6. Does an hour at the chosen operating point leave memory and disk flat?

## What the backend is

One Node process, one event loop, no clustering. Rooms and ledgers live in
memory, so the process cannot be sharded without sticky routing, and every
cost below lands on the same thread.

Per-message work, from `packages/server/src/relay.ts`:

| Event                     | Server work                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `inputs` from a player    | Decode, contiguity and pacing checks, append to the seat ledger, encode once, send to the peer and to every spectator |
| `digest` every 32 ticks   | Decode, compare with the peer's pending entry                                                                         |
| `hello`                   | Store lookup or insert (SQLite, synchronous), `welcome`, then a `room_list` to that session                           |
| Any lobby change          | Build a summary of every room, encode once, send to every helloed session (`broadcastRoomList`)                       |
| `spectate` mid-match      | Copy both ledgers into one `spectate_start` (up to `MAX_MATCH_FRAMES` = 1M frames per player)                         |
| Reconnect with a token    | Same ledger copy as `match_resume`                                                                                    |
| `result` or forfeit       | SQLite transaction for the W-L record                                                                                 |
| Scoreboard `/submit`      | Body read, parse, verifier slices of 2000 ticks, SQLite insert, two `standing` queries                                |
| Scoreboard `/scores` miss | Two SQLite reads, one an index range count                                                                            |

Costs that scale with something a load test can turn up:

- **Forwarding is O(1 + spectators) sends per input batch.** A player sends
  about 50 batches a second, so one game with S spectators is roughly
  100 x (1 + S) sends a second.
- **Room-list pushes are O(rooms x sessions) bytes per lobby event.** Every
  create, join, leave, spectate, start, and end rebroadcasts the whole list.
- **A ledger is a JS number array, 8 bytes a frame, 50 frames a second per
  seat.** A one-hour game holds about 1.4 MB per seat; the cap is 8 MB.
- **Late join copies the ledger and encodes it as JSON in one go.** A
  one-hour match's `spectate_start` is a few MB of text built synchronously.
- **`ws.send` is called without checking `bufferedAmount`.** A spectator
  that reads slowly accumulates unsent bytes in server memory with no cap.
- **`hello` and `result` touch SQLite synchronously.** A burst of new
  identities or simultaneous match ends is a burst of write transactions on
  the loop.

These are hypotheses. Scenarios L3, L4, L6, L7 and L9 exist to confirm or
refute each with a number.

## Metrics

Collected for every scenario, every 10 s, into one CSV per run.

**In the relay** (add a `STATS=1` env flag that prints these to stderr; a
small change with no behaviour effect):

- Event-loop delay p50, p99, max (`perf_hooks.monitorEventLoopDelay`).
- Sessions, helloed sessions, rooms, rooms playing, spectators total.
- Messages in and out per second, bytes out per second.
- Largest and total `ws.bufferedAmount` across sockets (backpressure).
- Largest ledger length.
- Scoreboard: verifier queue depth, cache size, limiter sizes.

**From the OS:** CPU of the relay process, RSS, open file descriptors,
NIC bytes out, and nginx's active connections when it is in the path.

**From the load generator:**

- **Forward latency:** time from a player bot sending an `inputs` batch to
  its peer receiving the matching `peer_inputs`. p50, p99, max. This is the
  number a player feels; it is the headline metric.
- **Spectator latency:** the same, measured at a spectator.
- **Lockstep stalls:** ticks a full-sim bot could not advance because the
  peer's frame had not arrived within `inputDelay`.
- **Late-join time:** `spectate` sent to `spectate_start` fully received.
- **Reconnect time:** `hello` with token sent to `match_resume` received.
- Error and fatal-close counts, desync count, and per-route status codes
  for the scoreboard.

## Tooling

A new workspace package, `tools/load-test/`, following `tools/replay-check/`
(own `package.json`, `tsc -b`, depends on `@crack-attack/core`,
`@crack-attack/protocol`, and `ws`). It is a CLI that runs one named scenario
with knobs and writes the CSV. Parts:

**Wire bot (player).** Speaks the protocol directly: `hello`, `create_room`
or `join_room`, `ready`, then sends one `inputs` batch per tick at real
50 Hz with plausible frame content (a scripted pattern of `CC_*` masks) and a
`digest` every 32 ticks copied from a lookup table. It does not run a sim, so
one Node process can drive thousands of them. Its digests will not match a
real sim's, so paired wire bots must both use the same table, which they do.
It records forward latency by tagging: the sender notes the send time of each
`startTick`, the receiver matches it on `peer_inputs`.

**Sim bot (player).** Drives the real client `LockstepSession` from
`packages/client/src/net/lockstep.ts` with the hard `AiController`, the way
`e2e.lockstep.test.ts` does. Heavier (a full sim pair per bot) but proves
that games at scale still verify: digests match, no desyncs, results agree.
Use a sample of these among wire bots (say 1 in 20 games).

**Spectator bot.** `hello`, `spectate`, then reads and validates contiguity
per player stream like `packages/client/src/net/spectator.ts` does, without
simulating. A `--slow` mode stops reading from the socket for a chosen
period, to create backpressure.

**Lobby idler.** `hello` and nothing else. Exists to receive `room_list`
pushes. Counts bytes received.

**Churner.** Creates and leaves rooms, or joins and leaves as a spectator, at
a set rate.

**Scoreboard driver.** As in the scoreboard section below: replay factory,
fake-client pool stamping `X-Forwarded-For`, per-route tallies.

**Generator sizing.** The relay's pacing check (`MAX_INPUT_LEAD_TICKS`)
means bots must send at real time; there is no fast-forward. One generator
process handles roughly 1,000 to 2,000 wire bots before its own timer
jitter pollutes latency numbers, so the CLI takes `--workers N` and forks.
For anything past a few thousand connections, run generators on a second
host and put the relay on its own core. Raise `ulimit -n` on both sides.
Verify the generator is not the bottleneck by running two generators at
half load each and checking the numbers match one at full load.

**Clock.** The relay's pacing clock is monotonic and cannot be injected in
the bundle. For the one scenario that needs a ledger near the 1M-frame cap
(L5c), run the relay in-process from `packages/server/src` with an injected
`now`, as the e2e test does; that is a correctness probe, not a capacity one.

## Environment

- The standalone bundle (`pnpm --filter @crack-attack/server bundle`,
  `node dist/relay.mjs`), on-disk SQLite in WAL mode.
- Two configurations, each scenario run in both where marked (nginx):
  relay direct, and relay behind nginx with TLS as in the README, since
  players connect through nginx and its overhead and connection limits are
  part of the answer.
- Record the machine: cores, clock, RAM, NIC, Node version, commit.

## Scenarios

Each gives the load, what to watch, and a pass line. "Knee" means the load at
which forward latency p99 rises above 20 ms (one tick) over baseline, or
event-loop delay p99 passes 10 ms, whichever comes first. Every scenario
ramps in steps and holds each step for 2 minutes before reading.

### L1. Baseline

One wire-bot game, no spectators, 5 minutes.

Watch: forward latency p50/p99, loop delay, RSS, CPU.
Pass: establishes the reference numbers every other scenario is compared to.

### L2. Idle sessions

Lobby idlers only: 500, 1,000, 2,500, 5,000, 10,000, connected 50 a second.
No rooms.

Watch: hello throughput (each new identity is a SQLite insert), RSS per
session, fds, time to welcome, and then one `create_room` to measure a
single room-list push to N sessions.
Pass: RSS under 50 KB per idle session; one push to 10,000 sessions stalls
the loop under 20 ms. Record the fd and RSS numbers; they set the connection
ceiling.

### L3. Concurrent games, no spectators

Wire-bot games: 10, 50, 100, 250, 500, 1,000, 2,000. One in 20 games is a
sim-bot pair. Rooms are created and started at 5 a second, then held.

Watch: forward latency p99 per step, loop delay, CPU, bytes out (expect
about 100 messages and 5 to 10 KB a second per game), desyncs from the
sim-bot games, RSS growth over the hold (ledgers).
Pass: the knee is the answer to question 1. Report games at the knee and
CPU at the knee; if CPU is under 80% at the knee, the limit is the loop or
the generator and the step should be repeated with two generators.

Repeat the step just below the knee behind nginx.

### L4. Spectators

**L4a, one game:** spectators 10, 50, 100, 250, 500, 1,000, 2,000, joining
20 a second.

**L4b, spread:** 50 games with 2, 5, 10, 20, 50 spectators each.

Watch: forward latency for the players (does watching slow the game?),
spectator latency, bytes out (each batch is copied per spectator), loop
delay, largest `bufferedAmount`.
Pass: the knee of L4a answers spectators per game; L4b answers total
spectators. Players' forward latency should not move until bytes out
approaches the NIC.

### L5. Long matches and late join

**L5a:** one wire-bot game held 30 minutes, then 100 spectators join within
one second.

**L5b:** same at 60 minutes.

**L5c (in-process, injected clock):** a ledger at 950k frames per seat, then
one late join and one reconnect.

Watch: `spectate_start` size, encode stall on the loop (this is one
synchronous `JSON.stringify` per joiner), late-join time, RSS spike, and
whether players' forward latency dips during the join burst.
Pass: at 60 minutes, 100 late joins do not push player p99 over 20 ms.
Expect this to fail; the fix is to encode the ledger once per burst or to
cap the history a spectator gets. L5c records the worst case for the docs.

### L6. Lobby churn

Idle sessions S in {500, 2,000, 5,000} crossed with open rooms R in
{50, 200, 500}, then a churner making lobby events at 1, 5, 20 a second.

Watch: bytes out per second (predicted: event rate x S x summary size,
where summary size grows with R), loop delay, and whether games running at
the same time (run 50 from L3 alongside) see forward latency move.
Pass: at S=2,000, R=200, 5 events a second, games are unaffected. Record
the product S x R x rate at which they are; that is the lobby ceiling and
the argument for diffing or throttling room-list pushes.

### L7. Slow readers and backpressure

One busy game with 20 spectators; 5 of them stop reading for 60 s, then
resume; then 5 stop reading permanently.

Watch: `bufferedAmount` on those sockets, RSS, whether the players or the
other 15 spectators are affected, and what happens to RSS when the
permanent ones are never disconnected by the server.
Pass: bounded memory. Expect this to fail as written; the fix is to close a
socket whose `bufferedAmount` passes a cap. Re-run after.

### L8. Reconnect storm

200 games in progress. Cut 200 player connections at once (kill the
generator's sockets, not the bots' state); all reconnect with their tokens
within 5 s. Then repeat with reconnects spread over 25 s so some fall past
the 30 s grace.

Watch: `match_resume` sizes and encode time, reconnect time p99, grace
timer firing accuracy, forfeits recorded (SQLite burst), loop delay, that
survivors' games kept running.
Pass: all 200 resume in under 2 s; the late group forfeits exactly; no
desyncs after resume in sim-bot games.

### L9. Match-end storm

500 wire-bot games that all report `result` in the same second (script the
bots to end at a fixed tick).

Watch: SQLite transaction burst on the loop, loop delay max, time until the
last `match_end` is delivered, room-list push count (one per ending).
Pass: loop delay max under 100 ms. The room-list pushes here are 500 pushes
to every session in one second; this is L6's ceiling from the other side.

### L10. Abusive WebSocket clients

In parallel, 2 minutes each, alongside 50 games:

- 500 connections that never send `hello`.
- 500 connections cycling connect, `hello`, disconnect at 100 a second.
- 50 clients sending 16 KiB frames as fast as they can.
- 50 clients sending malformed JSON at 1,000 messages a second.
- 50 players sending `inputs` faster than real time until the pacing check
  closes them, in a loop.

Watch: loop delay, CPU, RSS, fds, and the 50 real games' forward latency.
Pass: real games unaffected; every abusive connection is closed by the
rules that already exist; RSS returns to baseline after.

### L11. Scoreboard alongside netplay

Run the 50-game L3 step with the scoreboard at the ceiling its limits allow:
5 tickets a second, 3 submits a second (mix of the 451-tick `advance`
replay and the 3-minute hard-AI replay), 20 board reads a second from 5
clients cycling queries to defeat the cache, 2 replay reads a second. Table
seeded to 300k rows first.

Then the worst cases from the security review, one at a time, with the 50
games still running:

- Verifier saturation: 64 AI replays submitted in one second.
- Replay route at max concurrency, before and after it gets a rate limit.
- Cache thrash at 1M rows.
- Padded 26 KB replays at 5 a second for 30 minutes (disk growth per row).

Watch: the 50 games' forward latency above all, then verifier queue depth,
503 and 429 counts, DB growth, loop delay.
Pass: games' p99 within 5 ms of L3 at 50 games under the ceiling traffic;
each worst case is either harmless or has a named fix and a re-run.

### L12. Soak at the operating point

Take half the L3 knee in games, a quarter of the L4b knee in spectators,
500 idle sessions, one lobby event a second, and the L11 ceiling scoreboard
traffic. Hold one hour. Rotate games: every game ends and re-readies every
10 minutes, and 10% of players reconnect once.

Watch every minute: RSS, heap, loop delay p99, forward latency p99, DB and
WAL size, fds, `bufferedAmount` total, limiter and cache sizes.
Pass: RSS and fds flat over the last 40 minutes; latency flat; WAL
checkpoints; no error-log growth.

## Turning results into capacity

Report one table:

| Dimension               | Knee (measured) | Limiting resource | Operating point (50% of knee) |
| ----------------------- | --------------- | ----------------- | ----------------------------- |
| Concurrent games        | from L3         |                   |                               |
| Spectators per game     | from L4a        |                   |                               |
| Spectators total        | from L4b        |                   |                               |
| Idle sessions           | from L2         |                   |                               |
| Lobby events per second | from L6         |                   |                               |
| Reconnects per second   | from L8         |                   |                               |
| Scoreboard submits/s    | from L11        |                   |                               |

Then the deploy rule: one relay process serves up to the operating-point
column on the tested machine class; above that, a second relay on its own
hostname (rooms do not span processes, so players sharing a room must share
a relay, and the client's `VITE_RELAY_URL` picks which).

Keep each run's CSVs and table in `docs/load-test-results/<date>/` with the
commit and machine, so a later run is a diff.

## Order of work

1. Add the `STATS=1` probe to the relay.
2. Build `tools/load-test` with the wire bot, spectator bot and idler, and
   the CSV writer; prove it with L1 and a 10-game L3 step. Confirm the
   generator is not the bottleneck as described above.
3. Run L2, L3, L4 to get the three headline numbers.
4. Run L5, L6, L7, L9. Expect L5b, L6 at the top corner, and L7 to expose
   the hot spots named earlier; fix (ledger encode once per burst,
   room-list throttling or diffs, a `bufferedAmount` cap) and re-run those
   three.
5. Add the sim bot and re-run L3 and L8 with the 1-in-20 sample for
   correctness.
6. Run L10 and L11.
7. Run L12 the night before the first public deploy, and again after any
   change to `relay.ts`, `wsServer.ts`, `scoreboard.ts`, `httpApi.ts`,
   `soloVerifier.ts` or `sqliteStore.ts`.

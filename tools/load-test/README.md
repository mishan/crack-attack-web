# load-test

A load generator for the relay (`packages/server`), running the scenarios of
[`../../docs/LOAD_TEST_PLAN.md`](../../docs/LOAD_TEST_PLAN.md) (L1–L12) and
writing one CSV per run. It answers: how many concurrent games, spectators,
lobby sessions and reconnects one relay process carries, and what fails first.

## What it drives

- **Wire bots** — speak the protocol and keep lockstep (send one `inputs` batch
  a tick at real 50 Hz, a `digest` every 32 ticks from a shared table) without
  running a sim, so one process drives thousands. Paired bots share the digest
  table, so the relay sees agreement.
- **Sim bots** — drive the real client `LockstepSession` with the hard
  `AiController` (the e2e test's path): heavier, but they prove games at scale
  still verify (digests match, no desyncs). L3 mixes in one pair per 20 games.
- **Spectators** — `spectate`, then read both streams checking contiguity; a
  slow mode stops reading to make backpressure.
- **Lobby idlers, room sitters, churners** — load the room-list push path.
- **Abusive clients** — never-hello, connect/hello/disconnect churn, oversized
  frames, malformed JSON, over-pacing input (L10).
- **A scoreboard driver** — tickets, honest replays (played with the same core,
  in the shapes the security review measured), board and replay reads, each
  fake client stamping its own `X-Forwarded-For` (L11).

Each input batch is timed from its sender's clock to its receiver's, so the
**forward latency** a player feels is the headline number; spectator latency,
late-join, reconnect and welcome times, and the scoreboard's HTTP latency are
measured the same way. The relay's own numbers (event-loop delay, CPU, RSS,
fds, traffic, backpressure, queue sizes) come from its `STATS=1` probe
(`packages/server/src/stats.ts`), parsed from its stderr into the same CSV.

## Prerequisites

Build the workspace first (the CLI starts the relay from its build):

```sh
pnpm build
# For the marked runs, against the deploy artifact instead of dist/main.js:
pnpm --filter @crack-attack/server bundle   # then pass --bundle
```

Raise the file-descriptor limit on both the generator and the relay host before
large runs: `ulimit -n 1048576`.

## Running

```sh
# One scenario, defaults (starts its own relay with STATS=1 on an ephemeral port):
node tools/load-test/dist/cli.js l3

# A quick shake-out: one step, short hold, two workers:
node tools/load-test/dist/cli.js l3 --steps 1 --hold 20 --workers 2

# Against a relay you started yourself (e.g. behind nginx with TLS):
node tools/load-test/dist/cli.js l3 --relay wss://relay.example.com/ws
```

Key flags (`--help` for all): `--relay <url>`, `--bundle`, `--db <path>`,
`--trust-proxy <n>`, `--workers <n>`, `--out <path>`, `--hold <sec>`,
`--ramp <sec>`, `--interval <sec>`, `--steps <n>`, `--rotate <sec>`.

The CSV lands in `docs/load-test-results/<date>/<scenario>.csv` unless `--out`
says otherwise; keep each run's CSVs there with the commit and machine, so a
later run is a diff (plan, "Turning results into capacity").

### Workers

One generator process cleanly drives ~1,000–2,000 wire bots before its own
timer jitter pollutes the latency numbers; `--workers N` forks N of them. The
coordinator splits each step's populations across the workers. Scenarios that
centre on a single game (L1, L4a, L5, L7) always run in one worker. Confirm the
generator isn't the bottleneck by watching the `genLoop*`/`genCpuPct` columns,
and by running two workers at half load and checking the numbers match one at
full load. For thousands of connections, run the generator on a second host and
`--relay` at the relay on its own core.

### Pacing and timing

Bots arrive at the plan's rates: games are created and started at 5 a second,
spectators join at 20, and idle sessions (and room sitters and churners)
connect at 50, split across the workers. A step's ramp lasts until its new bots
have arrived at those rates, plus `--ramp` (15 s) to settle, before the reading
hold. Each step holds for its planned time: 2 minutes, or the plan's longer one
(L1 5 minutes, L5 30 and 60, the L11 padded flood 30, L12 an hour). `--hold`
replaces every step's hold, for a quick shake-out or a longer soak, and scales
the step's timed actions (a late-join burst, a storm) to match. L12's games end
and rematch every 10 minutes unless `--rotate` says otherwise.

L11's verifier saturation gathers its 64 AI runs during a 4-minute ramp (the
server won't take a run sooner than it could have been played) and submits them
together 10 s into the hold. The scoreboard driver offers each rate whether or
not earlier requests have come back, up to 32 in flight per loop; the
`scoreboardSkipped` column counts the beats it had to drop.

## Output columns

One row per sampling interval per step: the step and phase (`ramp`/`hold`),
generator populations, the latency percentiles (ms), generator counters and
health, then every relay `STATS` field (`relay*`, `sb*`) and the scoreboard's
per-route status tally. A short knee table prints to stdout at the end.

## Not covered here

L5c (a ledger near the 1M-frame cap) needs the relay run in-process with an
injected clock, as `packages/server/src/e2e.lockstep.test.ts` does — it's a
correctness probe, not a capacity one, and isn't a CLI scenario. Running behind
nginx is a deployment choice, not a flag: start the relay behind nginx and point
`--relay` at it.

# @crack-attack/ai-arena

Headless AI-vs-AI arena: pit two `AiController` tuning configs against each
other over a batch of seeds and report wins, survival, and garbage throughput.
This is the fitness function for tuning the bot — every planner or tuning
change should be measured here against a baseline, not eyeballed.

Both sims share a gameplay seed (identical starting boards) with garbage ports
cross-wired exactly as in netplay. Each controller also gets a distinct
seat-derived judgment seed that breaks ties between equally good moves, so
same-tier matches are intentionally asymmetric but remain fully reproducible.
For careful comparisons pass `--both` to replay every seed with the tunings in
both seats and aggregate out seat personality/order effects.

## Usage

```sh
pnpm --filter @crack-attack/ai-arena build
node tools/ai-arena/dist/cli.js --a hard --b medium --seeds 50
node tools/ai-arena/dist/cli.js --a candidate.json --b hard --seeds 50 --verbose
```

A side spec (`--a`/`--b`) is a difficulty preset (`easy`/`medium`/`hard`) or a
path to a JSON tuning file: overrides merged over a `base` preset, e.g.

```json
{ "base": "hard", "shatterWeight": 6, "dangerMargin": 4 }
```

See `AiTuning` in `@crack-attack/core` for every knob. Seeds run
`--first`..`--first + --seeds − 1` (default 1..20); `--max-ticks` caps match
length (default 30000 = 10 min game time; hitting it reports a `timeout`,
distinct from a same-tick double-loss `draw`).

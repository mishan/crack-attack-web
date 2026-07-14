# @crack-attack/replay-analyze

Analyze a saved human-vs-AI replay. The client's vs-AI screen grows a
**Save replay** button at game end; the file it downloads is just
`(seed, difficulty, ticks, your sparse inputs)` — the AI seat regenerates
deterministically, so the whole match reconstructs bit-exactly.

The analyzer replays both boards (same wiring and step order as the client)
and reports each seat through the same evaluator the AI plans with: swaps and
tempo, garbage throughput, chain/combo fires with bests, time spent in the
danger zone, and how often a worth-firing swap existed on the board (the
"planner's eye" opportunity rate — compare seats to see who converts more of
what the board offers). `--timeline` prints every fire in order.

```sh
pnpm --filter @crack-attack/replay-analyze build
node tools/replay-analyze/dist/cli.js replay-vs-hard-123456.json --timeline
```

Deterministic: the same replay file always produces the same report.

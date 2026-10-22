# screenshots

Retakes the screenshots in the top-level README, into `docs/images/`:

```sh
pnpm build && pnpm --filter @crack-attack/client build
pnpm --filter @crack-attack/screenshots shoot             # all of them
pnpm --filter @crack-attack/screenshots shoot lobby phone # some: demo, title, phone, lobby
```

It serves the built game, starts a relay on a free port with an in-memory
database, and drives Chromium (Playwright, WebGL in SwiftShader) through
[shotbox](https://github.com/mishan/shotbox): `shotbox exec` keeps the browser
off your desktop and network, and its `frames` helper stops the page's clock
and seeds `Math.random`. The game takes its seeds from `Math.random` and runs
on that clock, so the demo plays the same match every run and the moments
picked in `shoot.mjs` (by page time) stay put. The phone shot is a practice run, since a
ranked run's seed comes from the relay. The lobby shot runs in real
time: six browser contexts fill it with a match, a spectator, a waiting room
and a game against the AI. Its room codes come from the relay, so it changes a
little each run.

It needs `shotbox` on the PATH (`pipx install shotbox`; `shotbox doctor`
says what else) and Playwright's Chromium (`pnpm exec playwright install
chromium`, here). The demo GIF takes about three minutes to make.

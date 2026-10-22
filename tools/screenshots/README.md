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

## Accessibility audit

```sh
pnpm --filter @crack-attack/screenshots a11y               # every screen
pnpm --filter @crack-attack/screenshots a11y lobby account # some: attract, solo, gameover, phone, lobby, account, scores, ladder
```

It opens each screen (solo also opens both AI pickers; gameover waits a minute
or two for an untouched game to top out, then audits the name prompt, the game
over screen and the share dialog; phone is solo on a 375×667 touch screen,
with its touch controls) in a headed Chromium inside `shotbox run
--a11y`, and runs `shotbox a11y` `tree`, `lint`, `contrast` and `tabwalk` on
it. The reports and a screenshot of each go to `a11y-report/`, with a summary
per screen in `summary.txt`. It fails on a lint finding (an unnamed control or
image) or a Tab stop whose focus doesn't show. Low contrast is counted but
doesn't fail it, since it also measures text dimmed behind an open dialog and
the blinking PRESS ANY KEY mid-fade: read the `.contrast.json` reports.

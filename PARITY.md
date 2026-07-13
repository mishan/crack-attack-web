# Parity survey — what's left vs. the original C++

Audit of `crack-attack/` (reference source) against the port, focused on
presentation/meta; the rules layer is complete (see CLAUDE.md port status).
File:line references are into `crack-attack/src/`.

## Confirmed missing (the visible seven)

1. ~~**3-2-1-GO countdown**~~ **DONE** — `view/messages.ts` (pure, tested)
   carries the CountDownManager timeline: the client drivers hold sim stepping
   (and, in netplay, sending) for GC_START_PAUSE_DELAY = 150 ticks while 3/2/1
   swap every 50; GO rides the first 50 ticks of play. Esc-concede is blocked
   during the gate (as Game.cxx:186 blocks concession). Resumes and mid-match
   spectates skip the gate; from-the-start spectates mirror it by wall clock.

2. ~~**Stylized danger bar (LoseBar)**~~ **DONE** — `view/loseBar.ts` (pure,
   tested) ports the full `LoseBar.{h,cxx}` state machine: LB_INACTIVE /
   LB_LOW_ALERT / LB_HIGH_ALERT plus the three fade transitions
   (DC_LOSEBAR_FADE_TIME = 20), the two-phase fill (blue → magenta over the
   7s→1s low alert, then a reset to red over the 1s→0s high alert; bar value
   from Creep's `loss_alarm`), and the high-alert reset re-flash (detected as
   `loss_alarm` rising to the elimination floor, mirroring the
   `LoseBar::highAlertReset` Creep triggers at Creep.cxx:89). Colours are the
   DrawExternalCandy.cxx switch (INACTIVE/LOW/HIGH + the per-state fade lerps).
   `render/loseBarView.ts` draws it as a horizontal tube under each board — a
   small `ShaderMaterial` paints the two-colour sweep (alert colour filling in
   from the left over the lower colour, boundary at `bar`) with a cylindrical
   highlight and rounded caps. One per board, ticking with the sim, wired into
   solo + both netplay boards + spectator (like `LevelLightsView`). The plain
   vertical HUD height div stays — it and the LoseBar show different things
   (stack height vs. loss-countdown timer), as the original's level lights and
   losebar do. Divergence: a procedural shader tube stands in for the reference's
   baked 128×16 losebar texture.

3. ~~**Sparkles from dying blocks**~~ **DONE** — `view/sparkles.ts` (pure,
   tested) ports SparkleManager verbatim: death sparks (upward [π/4, 3π/4]
   fan, triangular velocity/spin/life distributions, gravity, end-of-life
   white pulse; count = the `pop_alarm`-stashed combo magnitude) and reward
   motes (level tables for color/type/size/inverse-mass, hold-then-launch
   with sibling staggering, upward force + center/twist springs, multiplier
   cross-fade). Core emits SparkEvent/MoteEvent at the exact C++ call sites;
   the render layer runs its own throwaway RNG (the C++ shared these ~20
   draws with the gameplay stream — the original reason for the cosmetic RNG
   split). Divergence: one procedural 5-point star stands in for the seven
   mote textures.

4. ~~**Screen shake on garbage impact**~~ **DONE** — `view/spring.ts` (pure,
   tested) ports `Spring.{h,cxx}` exactly; the core emits a cosmetic
   `ImpactEvent {y, height, width}` at the C++ call site (initial-fall garbage
   landings, Garbage.cxx:263) via the sign-sink pattern (digest-neutral), and
   each `BoardView` dips by the spring's offset (solo, both netplay boards,
   and spectator boards each have their own spring).

5. ~~**Level-light death flash (final-countdown blink)**~~ **DONE** —
   `view/levelLights.ts` now carries the full `LevelLights` state machine
   (pure, tested): red/blue fades over DC_LEVEL_LIGHT_FADE_TIME = 150 with
   mid-fade reversal mirroring, impact flashes (20-tick pulse with the 0.9
   inflection resync) fed by the cosmetic impact events, and the death strobe
   while the stack violates the safe height (re-arming only while the game is
   live). Colors come from the DrawLevelLights.cxx math (sqrt crossfade,
   whitening), boosted ×1.35 for our black background.

6. ~~**Bonus/sign coverage**~~ **DONE (audited)** — the survey's "appears
   unwired" was wrong: all 21 sign textures are converted (including
   `sign_bonus`), `signTextureKey` maps every kind, the level clamps match
   the C++ `maximum_levels` {8, 10, 8} exactly, and the emission sites are
   1:1 (ComboTabulator.cxx:67, GarbageGenerator.cxx:67/82/99). The one real
   gap found: the C++ tints ST_SPECIAL signs per matched flavor
   (`sign.color = level` → `sign_colors`, DrawCandy.cxx:51-60) where the port
   used one fixed orange — now faithful. Why bonus signs are rarely _seen_:
   they require eliminating a pattern of special blocks (at most one spawns
   per creep row at 1-in-GC_NO_SPECIAL_BLOCK_CHANCE_IN), which is uncommon in
   casual play — same as the original.

7. ~~**Big GAME OVER / winner / loser overlays**~~ **DONE** (PAUSED/ANYKEY
   excepted — they belong to items 12 and the solo pre-game flow) —
   `render/messageOverlay.ts` draws the original textures as a centered DOM
   overlay with the faithful cos² alpha pulse (obj_messages.cxx:166). GAME
   OVER on solo loss and netplay draws, WINNER/LOSER at any match end,
   WAITING for lockstep stalls (replacing the text banner). Note: the
   reference loads these PNGs as pure _alpha masks_ painted white
   (TextureLoader::loadImageAlpha) — their RGB is black — so the overlay
   whitens via `filter: brightness(0) invert(1)`.

## Also missing (smaller / adjacent)

8. ~~**Block dying flash**~~ **DONE** (survey correction: the DrawBlocks.cxx
   flash is the _dying_ strobe, not a landing flash) — `view/dyingAnim.ts`
   (pure, tested) ports the two-phase death exactly: 12 ticks full-size with
   two white strobe pulses (the folded triangle wave), then the quadratically
   accelerating tumble while shrinking to DC_DYING_SHRINK_MIN_SIZE = 0.1.
   Replaces the port's previous blended approximation in `BoardView`.
9. ~~**Win/loss celebration**~~ **DONE** — `view/celebration.ts` (pure,
   tested) ports `CelebrationManager.{h,cxx}` + the `DrawMessages.cxx`
   draw math: the board dims out over DC_CELEBRATION_FADE_TIME = 200, a WIN
   message scales in from ×12 while its alpha fades (opacity = win_alpha⁴) then
   strobes (the folded-triangle flash timers), and a LOSS / GAME OVER message
   drops from DC_STARTING_LOSS_HEIGHT and bounces to rest under gravity/drag
   with decaying elasticity. `render/messageOverlay.ts` grew a `setCelebration`
   that applies scale / drop-translate / opacity to the message `<img>`, a
   white-glow drop-shadow for the flash, and a black board-dim veil. A WIN also
   throws fireworks: the five-source sputtering-rate algorithm
   (`Celebration.drainSparkSpawns`) drives `Sparkles.createCelebrationSpark`
   (faithful angle fans / velocities / life, sharing the death-spark pool +
   gravity), launched on the winner's board. Wired into solo (loss → GAME OVER
   bounce) and netplay-playing (win scale-in/flash + fireworks, loss bounce),
   ticked on wall-clock after the sim freezes. Divergences: the exact
   win-message tint isn't ported (flash is a white glow); the firework source
   positions are placed around our single board (not the reference's two-board
   screen); solo never "wins" so its top-rank fireworks aren't shown; and the
   spectator view keeps its plain result message.
10. ~~**Score**~~ **DONE** (solo) — `Score.{h,cxx}` ported to the display
    layer. The core emits a cosmetic `ScoreEvent` snapshot of the reporting
    combo at the exact `ComboManager::timeStep` elimination point
    (ComboManager.cxx:73) via `core/score.ts` + `GameSim.drainScoreEvents` —
    RNG-free and out of the digest, so determinism is untouched. The client
    `view/score.ts` (pure, tested) reproduces the C++ math: per-elimination
    points (magnitude / gray / special-block bonuses), the ComboManager base_*
    bookkeeping + `reportMultiplier` chain bonus (reconstructed per-combo from
    the snapshot, keyed on id + creation stamp for pool reuse; the per-step
    multiplier count is the monotonic `nMultipliers` diffed across report
    ticks), and the speed-ramping backlog drip (`timeStepPlay`). Records are the
    pure, tested `view/scoreRecords.ts` (top-30 scores + top-10 multipliers,
    faithful ascending insertion) persisted to localStorage (`score/
scoreStore.ts`, replacing `~/.crack-attack/`), using the saved player name.
    The HUD shows the zero-padded drip score + BEST, and a new-high-score rank
    line on game over. Solo-only, matching the C++ `CM_SOLO` gate. Deferred: the
    textured 7-segment digit rendering (item 14) and a modal name-entry prompt
    (the saved name is used).
11. **WinRecord stars** — per-game stars across a best-of-3 match
    (`WinRecord.{h,cxx}`); pairs with the deferred `GC_GAMES_PER_MATCH`
    lifecycle.
12. ~~**Solo pause**~~ **DONE** — `P` toggles GS_PAUSED in solo: the sim
    freezes (the frame loop drains wall-clock time without stepping, so
    unpausing doesn't burst-catch-up), the `message_paused` overlay shows, and
    music pauses/resumes. Faithful to `Game::buttonPause` — you can't pause when
    the game is over, during the 3-2-1 countdown, or when you're about to lose
    (`creep_freeze`). Netplay pause stays retired with the sync-counter scheme,
    as noted.
13. ~~**Audio**~~ **DONE** — `Sound.{h,cxx}`, `Music.{h,cxx}` ported to
    WebAudio. The core emits cosmetic `SoundEvent`s on the existing sink
    pattern (`core/sound.ts`, `GameSim.drainSoundEvents`) at the exact C++
    `Sound::play` call sites — block awaking pop (Block.cxx:104, vol 5), block
    landing (Block.cxx:168, vol 2), block death (Block.cxx:274, vol
    spark_number/3), garbage landing (Garbage.cxx:256, vol width×height), and
    garbage shatter (Garbage.cxx:347, vol width×height) — all digest-neutral
    and RNG-free. The client `audio/audioManager.ts` plays SFX through an
    `AudioContext` (polyphonic, gesture-unlocked) and streams music through an
    `HTMLAudioElement` with the faithful `Music.cxx` state machine: prelude in
    the menu/lobby, fade-out over the 3-2-1 countdown, game loop at GO,
    gameover/youwin stingers at match end, plus pause/resume on tab-hide. The
    countdown beep schedule (CountDownManager.cxx:63-67, vols 10/7/4/1) is the
    pure, tested `view/messages.ts`. Volume math (mute + music/SFX sliders over
    the C++ levels, localStorage-persisted, `audio/volume.ts`) is pure/tested;
    an on-screen control + `M` shortcut drive it. Wired into solo, netplay
    (local board audible, faithful to per-client sound), and spectator (both
    boards). Assets are the Fedora/Arch fork set; see
    `packages/client/public/AUDIO_COPYRIGHT.txt` for provenance and the
    dual GPL / Crystal-Stacker-freeware licensing. Deferred: the commented-out
    shatter-to-garbage cue (Garbage.cxx:106, disabled upstream) and the X-mode
    extreme sound variants.
14. ~~**Textured clock/name rendering**~~ **DONE** — the original bitmap glyph
    fonts now render the clock, the score, and player names, replacing the DOM
    text. The `clock_*.tga` (digits + `clock_extra` separator) and all 86
    `font0_*.tga` glyphs are converted to two white-on-alpha PNG strip atlases
    (`public/textures/font/{clock,font0}.png`). `view/bitmapFont.ts` (pure,
    tested) ports the `String.cxx` metrics — the char→glyph map, the
    `letter_widths` advances, `DC_SPACE_WIDTH`, and the `fillStringTexture`
    cursor layout (glyphs are left-aligned 32-cells; the pen advances by the
    glyph width; unmapped chars are skipped). `render/bitmapText.ts`
    (`BitmapLabel`) loads an atlas once, composites a string onto a `<canvas>`,
    and tints it (the atlas is a white alpha mask, painted through with
    `source-in`), with a plain-text fallback until the atlas loads. Wired into
    the HUD clock + score (clock digit set) and per-board player names in
    netplay/spectator (font0, shown above each board). Divergences: the C++
    per-pixel diagonal brightness gradient and the `~` colour/font escape codes
    are dropped (flat tint, plain text); the lobby's DOM name list stays DOM
    (it's menu chrome, not above a board).

## Known and planned elsewhere

- ~~**AI opponent** (Phase 3)~~ **DONE** (this branch) — two flavours. The
  reference's gridless `ComputerPlayer` (a timed garbage state machine) is
  ported faithfully for parity in `core/computerPlayer.ts` (+ `GarbageQueue`,
  the Easy/Medium/Hard attack cadences and loss heights) and kept, but the
  _visible_ opponent is a real grid-playing bot: `core/aiController.ts`
  `AiController.decide(sim)` reads the board + swap cursor each tick and returns
  the next `ActionState` — a pure, deterministic function of sim state plus a
  tiny plan/timer (no clocks, no RNG), so all clients/spectators reproduce its
  moves identically. Easy plays reactively (clears what's one swap away); medium
  also digs blocks into gaps to churn matches; **hard is strategic** — it
  look-ahead-plans via a pure cascade evaluator (`core/aiPlanner.ts`: apply a
  candidate swap to a lightweight board copy, settle gravity, remove 3+ runs,
  repeat; counts chain depth ≈ multiplier, cleared ≈ magnitude, garbage
  shattered) and _banks_ small clears while safe, firing only chains / 4+ combos
  / garbage shatters (a plain 3-match sends no garbage, so those are what
  actually attack), dropping to survival clears when the stack tops out.
  Measured attack output escalates easy<medium<hard. **Solo vs AI**
  (`client/aiMatch.ts`) shows two real boards side by side (you + the bot's
  `GameSim`), cross-wired through the garbage seam like netplay, entered via a
  difficulty picker. **Netplay vs AI** (protocol v4) seats the bot as a
  deterministic _client-side seat_: its inputs never cross the wire — every
  client and spectator regenerates them locally from the same controller over
  the lockstep-identical AI sim, so `match_start`/`spectate_start` carry only an
  `aiOpponent` descriptor (difficulty + seat index). The relay hosts the "1
  human + 1 bot" room (single-ready start; human drop tears it down; not
  persisted to W-L). A "vs AI" lobby button opens the picker; spectators see the
  identical AI. Deferred within Phase 3: the abstract-AI's own visible UI (the
  `ComputerPlayer` core is retained but not surfaced).
- **X-mode**, **replays** (ActionRecorder / CM_REPLAY), **custom garbage-flavor
  image exchange** — tracked in BROWSER_PORT_PLAN.md phases/stretch.

## Suggested order

Cheap and high-impact first: ~~(5) light flashes + (8) dying flash + (4)
screen shake~~, ~~(1) countdown and (7) message overlays~~, ~~(3) sparkles,
(6) bonus sign audit~~, ~~(13) audio~~, ~~(10) score~~, ~~(2) lose bar~~,
~~(9) celebration~~, ~~(12) pause~~, ~~(14) glyph rendering~~ (done); remaining:
(11) stars.

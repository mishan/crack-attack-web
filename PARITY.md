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

2. **Stylized danger bar (LoseBar)** — `LoseBar.{h,cxx}`, `DrawLoseBar.cxx`.
   A textured horizontal tube under the board (length 7.0, 128×16 texture,
   Displayer.h:504-515) with a state machine: LB_INACTIVE / LB_LOW_ALERT /
   LB_HIGH_ALERT plus three fade transitions (LoseBar.h:33-38,
   DC_LOSEBAR_FADE_TIME = 20). Our current bar is a plain HUD div; the states
   map cleanly onto the existing `view/hud.ts` thresholds.

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
9. **Win/loss celebration** — `CelebrationManager.{h,cxx}`: end-of-match
   dancing-squares animation behind the WINNER/LOSER message.
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
12. **Solo pause** — GS_PAUSED + MS_PAUSED overlay (netplay pause deliberately
    retired with the sync-counter scheme; solo pause is trivial).
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
14. **Textured clock/name rendering** — `data/clock_*.tga`, `font0_*.tga`
    glyph textures for names/scores above the boards. We render DOM text;
    parity here is cosmetic taste.

## Known and planned elsewhere

- **AI opponent** (Phase 3), **X-mode**, **replays** (ActionRecorder /
  CM_REPLAY), **custom garbage-flavor image exchange** — tracked in
  BROWSER_PORT_PLAN.md phases/stretch.

## Suggested order

Cheap and high-impact first: ~~(5) light flashes + (8) dying flash + (4)
screen shake~~, ~~(1) countdown and (7) message overlays~~, ~~(3) sparkles,
(6) bonus sign audit~~, ~~(13) audio~~, ~~(10) score~~ (done); next (2) lose bar; then
(11) stars, (9) celebration, (12) pause, (14) glyph rendering.

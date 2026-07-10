# Parity survey — what's left vs. the original C++

Audit of `crack-attack/` (reference source) against the port, focused on
presentation/meta; the rules layer is complete (see CLAUDE.md port status).
File:line references are into `crack-attack/src/`.

## Confirmed missing (the visible seven)

1. **3-2-1-GO countdown** — `CountDownManager.{h,cxx}`, `Game.cxx:399-408`.
   While `start_pause_alarm != 0` (GC_START_PAUSE_DELAY = 150 ticks = 3 s,
   Game.h:220) the _entire_ gameplay step is skipped (`continue`), the clock
   holds, and concession is blocked (Game.cxx:186); only the communicator and
   meta systems tick. The message switches every 50 ticks: 3 → 2 → 1, then GO
   shows as play begins (MS_COUNT_DOWN_* MessageManager.h:37-40; art:
   `data/count_down_{3,2,1,go}.png`). Port note: a pure meta gate — the client
   drivers hold sim stepping for 150 ticks after match start; lockstep is
   unaffected (both sides gate identically, buffering absorbs skew).

2. **Stylized danger bar (LoseBar)** — `LoseBar.{h,cxx}`, `DrawLoseBar.cxx`.
   A textured horizontal tube under the board (length 7.0, 128×16 texture,
   Displayer.h:504-515) with a state machine: LB_INACTIVE / LB_LOW_ALERT /
   LB_HIGH_ALERT plus three fade transitions (LoseBar.h:33-38,
   DC_LOSEBAR_FADE_TIME = 20). Our current bar is a plain HUD div; the states
   map cleanly onto the existing `view/hud.ts` thresholds.

3. **Sparkles from dying blocks** — `SparkleManager.{h,cxx}` (pooled
   `spark_count` sparks + reward "motes", SparkleManager.h:71-78). Sparks
   spawn at block death (count scales with the combo's `latest_magnitude` —
   already ported into ComboTabulator for exactly this), flavor-colored, with
   gravity/tumble physics. This is the flagship use of the reserved
   `cosmeticRng`. Reward motes also fly toward the level lights on combos.

4. **Screen shake on garbage impact** — `Spring.{h,cxx}`, applied at
   Displayer.cxx:638. A damped spring on the board's y:
   `notifyImpact(h, w): v -= (SP_IMPACT_VELOCITY + v)·(h·w)·SP_GARBAGE_DENSITY`,
   per tick `y += v; v -= SP_STIFFNESS·y + SP_DRAG·v`. Port note: the sim's
   `Grid.notifyImpact` is the trigger point — expose a cosmetic impact event
   (same pattern as `SignSink`), integrate the spring in the render layer and
   offset each `BoardView` by its y.

5. **Level-light death flash (final-countdown blink)** — `LevelLights.h:105-137`,
   DC_LEVEL_LIGHT_DEATH_FLASH_TIME = 12 (Displayer.h:335). When the loss
   countdown runs, all arrows strobe; arrows also impact-flash when garbage
   lands (LS_IMPACT_FLASH) and fade between red/blue (LS_FADE_*) rather than
   snapping. Our `view/levelLights.ts` has only the static red/blue rule —
   it can compute all of this from sim state it already sees (loss_alarm,
   impacts) without any wire changes.

6. **Bonus/sign coverage** — `SignManager.{h,cxx}`; art exists for magnitude
   4-12 (`sign_4..12`), multipliers ×2-×12 (`sign_x2..x12`), and
   `sign_bonus.tga` (eliminations beyond the table / special blocks). The
   SignSink events fire at the right places; audit `render/signsView.ts`'s
   texture table — the bonus sign appears unwired.

7. **Big GAME OVER / winner / loser overlays** — `MessageManager.{h,cxx}`:
   full-screen pulsing textured messages (MS_GAME_OVER solo, MS_WINNER /
   MS_LOSER netplay, MS_WAITING, MS_PAUSED, MS_ANYKEY; MessageManager.h:37-46;
   art: `data/message_*.png`). We show DOM text banners; swapping in the
   textured sprites (SignsView pattern) or styling the banner to match is a
   taste call.

## Also missing (smaller / adjacent)

8. **Block landing flash** — blocks flash white for a few ticks on landing
   (DrawBlocks.cxx flash path). Small `deriveViewModel` + material tweak.
9. **Win/loss celebration** — `CelebrationManager.{h,cxx}`: end-of-match
   dancing-squares animation behind the WINNER/LOSER message.
10. **Score** — `Score.{h,cxx}`: per-elimination scoring with a backlog that
    drips into the displayed total (Score.h:77), multiplier records, and the
    hall-of-fame persistence (`~/.crack-attack/`, `data/default_record`).
    Deliberately deferred out of core; a display-layer port reading the
    ComboTabulator fields (`base_accumulated_score` is already maintained).
11. **WinRecord stars** — per-game stars across a best-of-3 match
    (`WinRecord.{h,cxx}`); pairs with the deferred `GC_GAMES_PER_MATCH`
    lifecycle.
12. **Solo pause** — GS_PAUSED + MS_PAUSED overlay (netplay pause deliberately
    retired with the sync-counter scheme; solo pause is trivial).
13. **Audio** — `Sound.{h,cxx}`, `Music.{h,cxx}` (SDL_mixer; init at
    Attack.cxx:149-151, music pauses with the game). The upstream `data/`
    tree ships no audio assets (fork-supplied), so the web build needs its
    own sources; WebAudio + a small event sink (combo, pop, land, drop) fits
    the existing cosmetic-sink pattern.
14. **Textured clock/name rendering** — `data/clock_*.tga`, `font0_*.tga`
    glyph textures for names/scores above the boards. We render DOM text;
    parity here is cosmetic taste.

## Known and planned elsewhere

- **AI opponent** (Phase 3), **X-mode**, **replays** (ActionRecorder /
  CM_REPLAY), **custom garbage-flavor image exchange** — tracked in
  BROWSER_PORT_PLAN.md phases/stretch.

## Suggested order

Cheap and high-impact first: (5) light flashes + (8) landing flash + (4)
screen shake are small, self-contained render-layer wins; then (1) countdown
and (7) message overlays (shared textured-overlay plumbing); then (2) lose
bar, (3) sparkles, (6) bonus sign audit; then (10)/(11) score + stars, (9)
celebration, (12) pause, (13) audio, (14) glyph rendering.

/**
 * @crack-attack/client — browser entry point.
 *
 * Wires the platform layers around the deterministic core into a playable solo
 * board: a {@link FixedTimestep} advances a `GameSim` at 50 Hz from real time,
 * {@link KeyboardInput} feeds it the player's actions, {@link deriveViewModel}
 * turns each tick's sim state into sprites, {@link ViewInterpolator} smooths the
 * motion between ticks by the render `alpha`, and {@link BoardView} draws it.
 *
 * Solo and netplay are switchable in-client (each mode returns a disposable
 * handle); no URL parameters are required. `?net` still force-boots netplay
 * and `?relay=` still overrides the relay URL, for muscle memory and dev
 * convenience.
 *
 * The sim is authoritative and deterministic; everything here is replaceable
 * platform glue (and stays out of `packages/core`, which must not touch the DOM).
 */

import { GameSim, GC_STEPS_PER_SECOND } from '@crack-attack/core';
import { KeyboardInput } from './input/keyboard.js';
import { mountTouchControls } from './input/touchControls.js';
import { BoardView, DEFAULT_RENDER_TUNING } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { HudView } from './render/hudView.js';
import { mountRenderTuner } from './render/renderTuner.js';
import { LevelLightsView } from './render/levelLightsView.js';
import { SignsView } from './render/signsView.js';
import { MessageOverlay } from './render/messageOverlay.js';
import { SparklesView } from './render/sparklesView.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { COUNTDOWN_GATE_TICKS, countdownMessage } from './view/messages.js';
import { Spring } from './view/spring.js';
import { ViewInterpolator } from './view/viewInterpolator.js';
import { AudioManager } from './audio/audioManager.js';
import { mountAudioControls } from './audio/audioControls.js';
import { ScoreState } from './view/score.js';
import { humanRank, insertMult, insertScore } from './view/scoreRecords.js';
import {
  loadMultRecords,
  loadPlayerName,
  loadScoreRecords,
  saveMultRecords,
  saveScoreRecords,
} from './score/scoreStore.js';

const SEED = 0x1a2b3c4d;
const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
/** Cap sign advance per frame so a long stall (tab refocus) doesn't warp them away. */
const MAX_SIGN_DT_TICKS = 10;

const SOLO_HELP = '←→↑↓ move · Z / Space swap · X raise · R restart · M mute';
const NET_HELP =
  '←→↑↓ move · Z / Space swap · X raise · R ready/rematch · Esc concede/stop watching · M mute';

/** A running mode (solo board or netplay shell); dispose to switch away. */
interface ModeHandle {
  dispose(): void;
}

/**
 * Where the relay lives, in priority order: `?relay=` (dev convenience) →
 * `VITE_RELAY_URL` (baked at build time — the deployment story, e.g.
 * `wss://example.com/ws` behind a reverse proxy) → same host on the default
 * port, with the scheme following the page's security context (an https page
 * can only open wss sockets under mixed-content rules).
 */
function resolveRelayUrl(params: URLSearchParams): string {
  const fromParam = params.get('relay');
  if (fromParam) return fromParam;
  const fromEnv = import.meta.env['VITE_RELAY_URL'] as string | undefined;
  if (fromEnv) return fromEnv;
  const scheme = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${globalThis.location.hostname}:8080`;
}

/** Whether an event target is a form control or editable element (keys should pass through). */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function boot(): void {
  const app = document.getElementById('app');
  const hudEl = document.getElementById('hud');
  if (!app) throw new Error('missing #app container');

  const params = new URLSearchParams(globalThis.location.search);
  const relayUrl = resolveRelayUrl(params);
  const help = document.getElementById('help');

  // One AudioManager spans both modes so music and settings survive a switch.
  // Browsers gate audio behind a gesture: unlock on the first key/pointer, and
  // pause music while the tab is hidden (C++ Music::pause/resume on GS_PAUSED).
  const audio = new AudioManager();
  const audioUi = mountAudioControls(audio);
  audio.playPrelude(); // menu music; starts once the first gesture unlocks audio
  // Unlock on user gestures. Listeners stay attached (not one-shot): unlock() is
  // cheap and idempotent, and keeping them means a later autoplay/resume
  // rejection (e.g. after tab backgrounding) can recover on the next gesture by
  // resuming a suspended context and retrying any queued track.
  const onGesture = (): void => audio.unlock();
  globalThis.addEventListener('pointerdown', onGesture);
  globalThis.addEventListener('keydown', onGesture);
  globalThis.addEventListener('keydown', (e) => {
    // Ignore auto-repeat (holding M is one toggle) and keys typed into a form
    // control / editable element (sliders, future text inputs) so adjusting
    // settings doesn't accidentally mute.
    if (e.code === 'KeyM' && !e.repeat && !isTypingTarget(e.target)) {
      audio.toggleMuted();
      audioUi.syncMuted();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.pauseMusic();
    else audio.resumeMusic();
  });

  let current: ModeHandle | null = null;
  const enter = (mode: 'solo' | 'net'): void => {
    current?.dispose();
    current = null;
    if (hudEl) hudEl.textContent = '';
    if (help) help.textContent = mode === 'net' ? NET_HELP : SOLO_HELP;
    if (mode === 'net') {
      void import('./netplay.js').then((m) => {
        current = m.bootNetplay(app, hudEl, relayUrl, () => enter('solo'), audio);
      });
    } else {
      current = bootSolo(app, hudEl, () => enter('net'), audio);
    }
  };

  enter(params.has('net') ? 'net' : 'solo');
}

function bootSolo(
  app: HTMLElement,
  hudEl: HTMLElement | null,
  onPlayOnline: () => void,
  audio: AudioManager,
): ModeHandle {
  let sim = new GameSim(SEED);
  const clock = new FixedTimestep();
  const input = new KeyboardInput();
  const interp = new ViewInterpolator();
  // One grid walk to read the board dimensions and seed the interpolator.
  const initial = deriveViewModel(sim);
  interp.push(initial);
  const view = new BoardView(app, initial.width, initial.visibleHeight);
  const halfW = (initial.width - 1) / 2;
  const halfH = (initial.visibleHeight - 1) / 2;
  const signs = new SignsView(view.scene, halfW, halfH);
  const decals = new GarbageDecalView(view.scene, halfW, halfH);
  const levelLights = new LevelLightsView(view.scene, halfW, halfH);
  const sparkles = new SparklesView(view.scene, halfW, halfH);
  const spring = new Spring();
  const overlay = new MessageOverlay(app);
  const hud = hudEl ? new HudView(hudEl) : null;
  let disposed = false;
  let rafId = 0;
  /** Ticks since game start, counting the held countdown gate. */
  let metaTicks = 0;
  // Audio lifecycle for this game: game music starts at GO, the game-over stinger
  // on loss (each fired once). Mirrors the C++ CountDownManager/CelebrationManager
  // music transitions.
  let gameMusicOn = false;
  let endMusicOn = false;
  audio.resetCountdown();
  // Fade the menu prelude over the first 3-2-1 (C++ gameStart → Music::fadeout),
  // matching restart(); game music takes over at GO.
  audio.fadeoutMusic(3000);
  levelLights.reset(initial.hud.topEffectiveRow);

  // --- solo scoring (display layer; Score.cxx) -----------------------------
  const score = new ScoreState();
  let scoreSubmitted = false;
  /** The current best (top) high score, for the "BEST" readout. */
  const bestScore = (): number => {
    const table = loadScoreRecords();
    return table[table.length - 1]?.score ?? 0;
  };
  const showBest = (): void => hud?.setScoreRecord(`BEST ${bestScore()}`);
  hud?.updateScore(score.formatted());
  showBest();

  /** On a loss, fold points into the score and record any new high score / multiplier. */
  const submitScore = (): void => {
    if (scoreSubmitted) return;
    scoreSubmitted = true;
    score.flush();
    hud?.updateScore(score.formatted());

    const name = loadPlayerName();
    const scoreRes = insertScore(loadScoreRecords(), name, score.score);
    if (scoreRes.rank >= 0) saveScoreRecords(scoreRes.records);
    const multRes = insertMult(loadMultRecords(), name, score.topMultiplier);
    if (multRes.rank >= 0) saveMultRecords(multRes.records);

    if (scoreRes.rank >= 0) {
      hud?.setScoreRecord(
        `NEW HIGH SCORE — rank #${humanRank(scoreRes.rank, scoreRes.records.length)}`,
      );
    } else {
      showBest();
    }
  };

  // Temporary lighting/material tuner — open with `?tune` in the URL.
  if (new URLSearchParams(globalThis.location.search).has('tune')) {
    mountRenderTuner(view, DEFAULT_RENDER_TUNING);
  }

  const fitToWindow = (): void => view.resize(globalThis.innerWidth, globalThis.innerHeight);
  fitToWindow();
  globalThis.addEventListener('resize', fitToWindow);

  // Mode switch into netplay.
  const onlineBtn = document.createElement('button');
  onlineBtn.textContent = 'Play online';
  onlineBtn.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:5;padding:6px 12px;opacity:.85';
  onlineBtn.onclick = onPlayOnline;
  document.body.appendChild(onlineBtn);

  // --- input ---------------------------------------------------------------
  const restart = (): void => {
    sim = new GameSim(SEED); // fresh deterministic game
    clock.reset();
    interp.reset();
    const fresh = deriveViewModel(sim);
    interp.push(fresh);
    signs.clear();
    decals.clear();
    sparkles.clear();
    input.clear();
    spring.gameStart();
    view.setShake(0);
    levelLights.reset(fresh.hud.topEffectiveRow);
    metaTicks = 0;
    // Fade the ending stinger over the new countdown, then game music at GO
    // (C++ gameStart → Music::fadeout(3000); GO → Music::play).
    gameMusicOn = false;
    endMusicOn = false;
    audio.resetCountdown();
    audio.fadeoutMusic(3000);
    // Reset scoring for the new game.
    score.reset();
    scoreSubmitted = false;
    hud?.updateScore(score.formatted());
    showBest();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyR') {
      restart();
      return;
    }
    if (input.handles(e.code)) {
      input.press(e.code);
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => input.release(e.code);
  // Don't let inputs stick if focus leaves the tab mid-press.
  const onBlur = (): void => input.clear();
  globalThis.addEventListener('keydown', onKeyDown);
  globalThis.addEventListener('keyup', onKeyUp);
  globalThis.addEventListener('blur', onBlur);

  // On-screen controls for touch devices; they feed the same KeyboardInput.
  const touch = mountTouchControls({
    press: (code) => input.press(code),
    release: (code) => input.release(code),
    restart,
  });
  // The keyboard hint is useless on a phone — hide it when touch controls mount.
  if (touch) {
    const help = document.getElementById('help');
    if (help) help.style.display = 'none';
  }

  // --- loop ----------------------------------------------------------------
  let lastMs = performance.now();
  const frame = (nowMs: number): void => {
    if (disposed) return;
    // Advance the sim only while the game is live. On a loss we stop stepping, so
    // the clock (and thus the HUD timer) and the board freeze on the final tick
    // until the player restarts.
    let stepped = 0;
    let gateTicks = 0; // wall ticks the countdown gate consumed this frame
    if (!sim.lost) {
      const steps = clock.sample(nowMs);
      for (let s = 0; s < steps; s++) {
        // Countdown gate: the whole gameplay step is held for the first
        // GC_START_PAUSE_DELAY ticks (Game.cxx:399-408) while 3-2-1 shows.
        if (metaTicks < COUNTDOWN_GATE_TICKS) {
          metaTicks++;
          gateTicks++;
          continue;
        }
        sim.step(input.actionState());
        stepped++;
        metaTicks++;
        // Interpolation only needs the last two ticks, so under catch-up (steps > 1)
        // skip the expensive grid-walk for the intermediate ticks that get
        // discarded — but always capture the tick a loss lands on.
        if (s >= steps - 2 || sim.lost) interp.push(deriveViewModel(sim));
        if (sim.lost) break;
      }
      // Spawn reward signs for the combos that fired across this frame's ticks.
      for (const ev of sim.drainSignEvents()) signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
    }

    // Audio: countdown beeps track the meta timeline; game music starts at GO.
    audio.updateCountdown(metaTicks);
    if (!gameMusicOn && metaTicks >= COUNTDOWN_GATE_TICKS) {
      gameMusicOn = true;
      audio.playGame(); // C++ CountDownManager GO → Music::stop + Music::play
    }
    // Gameplay sound cues (landings, pops, deaths, shatters) for this frame.
    audio.playCues(sim.drainSoundEvents());
    // The game-over stinger on the tick a loss lands (C++ CelebrationManager).
    if (sim.lost && !endMusicOn) {
      endMusicOn = true;
      audio.playGameOver();
    }

    // Scoring: fold in this frame's eliminations, then drip the backlog into the
    // shown total on the ticks that actually played (Score::timeStepPlay).
    for (const ev of sim.drainScoreEvents()) score.report(ev);
    score.timeStep(stepped);
    hud?.updateScore(score.formatted());
    if (sim.lost) submitScore();

    // Cosmetic garbage-landing impacts: kick the shake spring and flash the
    // lights; both tick with the sim (they freeze when it does).
    const impacts = sim.drainImpactEvents();
    for (const imp of impacts) spring.notifyImpact(imp.height, imp.width);
    for (let t = 0; t < stepped; t++) spring.timeStep();
    view.setShake(spring.offsetCells);

    // Death sparks + reward motes, ticking with the sim like the spring.
    for (const ev of sim.drainSparkEvents()) sparkles.spawnSparks(ev.x, ev.y, ev.flavor, ev.count);
    for (const ev of sim.drainMoteEvents()) sparkles.spawnMote(ev.x, ev.y, ev.level, ev.sibling);
    sparkles.advance(stepped);
    sparkles.sync();

    // Signs float on wall-clock time (and keep fading out after a loss).
    const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
    lastMs = nowMs;
    signs.update(dtTicks);

    // After a loss show the frozen final tick (alpha 1) rather than interpolating
    // toward a state the sim will never reach.
    // Big overlay: GAME OVER once lost, else the countdown / GO sequence.
    overlay.show(sim.lost ? 'message_game_over' : countdownMessage(metaTicks));
    overlay.update(dtTicks);

    const vm = interp.sample(sim.lost ? 1 : clock.alpha);
    view.update(vm);
    decals.update(vm.garbage);
    // Lights tick through the countdown gate too (Game.cxx:389 runs before
    // the gate check) — the start-of-game fade completes exactly at GO.
    levelLights.update(gateTicks + stepped, vm.hud.topEffectiveRow, !sim.lost, impacts);
    view.render();
    hud?.update(vm.hud);

    rafId = globalThis.requestAnimationFrame(frame);
  };
  rafId = globalThis.requestAnimationFrame(frame);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      globalThis.removeEventListener('resize', fitToWindow);
      globalThis.removeEventListener('keydown', onKeyDown);
      globalThis.removeEventListener('keyup', onKeyUp);
      globalThis.removeEventListener('blur', onBlur);
      touch?.remove();
      onlineBtn.remove();
      overlay.dispose();
      view.dispose(); // release the WebGL context (browsers cap them)
    },
  };
}

boot();

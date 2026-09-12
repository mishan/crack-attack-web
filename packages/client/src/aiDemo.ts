/**
 * aiDemo.ts — AI-vs-AI demo mode: two visible bot boards playing each other,
 * match after match, for the viewer's amusement (and to show the game off).
 *
 * The match itself is the DOM-free {@link AiVsAiMatch} — the in-browser twin of
 * `tools/ai-arena` (same seeding, same garbage cross-wiring). This file is the
 * render/timing glue, reusing the per-board view stack from `aiMatch`. Each
 * board carries its own message overlay and celebration, so the winner's side
 * shows WINNER + fireworks and the loser's side LOSER, as in the reference's
 * two-board layout. A few seconds after a match ends the next one kicks off on
 * a fresh seed, keeping a running tally. The viewer can pause, skip ahead, and
 * run the game at 1×/2×/4× speed.
 *
 * It also runs as the attract mode (the default landing screen; see
 * `view/attract.ts`): given an {@link AttractOverlay}, the demo is silent and
 * watch-only, holds on the title card before each match, and brings the title
 * back after each result, resetting the boards behind it.
 */

import { GC_STEPS_PER_SECOND, generateSeed, type AiDifficultyLevel } from '@crack-attack/core';
import type { AttractOverlay } from './render/attractOverlay.js';
import { TITLE_FADE_TICKS, TITLE_HOLD_TICKS, TITLE_RETURN_TICKS } from './view/attract.js';
import { BoardView } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { LevelLightsView } from './render/levelLightsView.js';
import { LoseBarView } from './render/loseBarView.js';
import { MessageOverlay } from './render/messageOverlay.js';
import { SignsView } from './render/signsView.js';
import { SparklesView } from './render/sparklesView.js';
import { AiVsAiMatch } from './sim/aiVsAi.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { Celebration } from './view/celebration.js';
import { COUNTDOWN_GATE_TICKS, countdownMessage, type MessageKind } from './view/messages.js';
import { Spring } from './view/spring.js';
import { ViewInterpolator } from './view/viewInterpolator.js';
import type { GameSim } from '@crack-attack/core';
import type { AudioManager } from './audio/audioManager.js';

const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
const MAX_SIGN_DT_TICKS = 10;
/** Playback speeds the viewer cycles through (sim ticks per wall-clock tick). */
const SPEEDS = [1, 2, 4] as const;
/** Wall ticks from a match's end to the next kickoff: the celebration (225) plus a beat. */
const NEXT_MATCH_DELAY_TICKS = 350;

export interface AiDemoHandle {
  dispose(): void;
}

/** Everything one rendered board needs. */
interface Board {
  container: HTMLDivElement;
  view: BoardView;
  interp: ViewInterpolator;
  signs: SignsView;
  decals: GarbageDecalView;
  levelLights: LevelLightsView;
  loseBar: LoseBarView;
  spring: Spring;
  sparkles: SparklesView;
  overlay: MessageOverlay;
  celebration: Celebration;
}

/**
 * Start the demo: `left` and `right` bots play back-to-back matches until
 * disposed. Pass `attract` (owned by the caller, and showing its title card)
 * to run it as the attract mode.
 */
export function bootAiDemo(
  app: HTMLElement,
  hudEl: HTMLElement | null,
  left: AiDifficultyLevel,
  right: AiDifficultyLevel,
  audio: AudioManager,
  onExit: () => void,
  attract: AttractOverlay | null = null,
): AiDemoHandle {
  const clock = new FixedTimestep();
  let match = new AiVsAiMatch(generateSeed(), left, right);
  const boards = [
    makeBoard(match.sims[0], `CPU · ${left}`, 0),
    makeBoard(match.sims[1], `CPU · ${right}`, 1),
  ] as [Board, Board];
  if (hudEl) hudEl.textContent = '';

  const wins: [number, number] = [0, 0];
  let draws = 0;
  let matchNo = 1;
  let speedIdx = 0;
  let paused = false;
  /** Wall ticks since kickoff, counting the countdown gate (drives 3-2-1-GO + beeps). */
  let metaTicks = 0;
  /** Whether the current match's result has been tallied and celebrated. */
  let tallied = false;
  let endWait = 0;
  let celebAccum = 0;
  let gameMusicOn = false;
  let disposed = false;
  let rafId = 0;
  /** Attract mode: wall ticks left on the title card before the countdown starts. */
  let kickoffWait = attract ? TITLE_HOLD_TICKS : 0;

  // Attract mode is silent, like an arcade cabinet's: the menu music (if on)
  // plays on, and no countdown beeps, cues, or stingers sound.
  if (!attract) {
    audio.resetCountdown();
    audio.fadeoutMusic(3000);
  }

  function makeBoard(sim: GameSim, label: string, side: 0 | 1): Board {
    const container = document.createElement('div');
    container.style.cssText = `position:absolute;top:0;bottom:0;width:50%;${side === 0 ? 'left:0' : 'right:0'}`;
    app.appendChild(container);

    const tag = document.createElement('div');
    tag.textContent = label;
    // Below the top-right audio controls, which would otherwise cover the right tag.
    tag.style.cssText =
      'position:absolute;top:52px;left:0;right:0;text-align:center;z-index:2;pointer-events:none;' +
      'font:600 14px system-ui,sans-serif;letter-spacing:1px;color:#e7ebf3;text-transform:uppercase';
    container.appendChild(tag);

    const vm = deriveViewModel(sim);
    const interp = new ViewInterpolator();
    interp.push(vm);
    const view = new BoardView(container, vm.width, vm.visibleHeight);
    const halfW = (vm.width - 1) / 2;
    const halfH = (vm.visibleHeight - 1) / 2;
    const levelLights = new LevelLightsView(view.scene, halfW, halfH);
    levelLights.reset(vm.hud.topEffectiveRow);
    return {
      container,
      view,
      interp,
      signs: new SignsView(view.scene, halfW, halfH),
      decals: new GarbageDecalView(view.scene, halfW, halfH),
      levelLights,
      loseBar: new LoseBarView(view.scene, halfW, halfH),
      spring: new Spring(),
      sparkles: new SparklesView(view.scene, halfW, halfH),
      overlay: new MessageOverlay(container),
      celebration: new Celebration(),
    };
  }

  function resetBoard(b: Board, sim: GameSim): void {
    b.interp.reset();
    b.signs.clear();
    b.decals.clear();
    b.sparkles.clear();
    b.spring.gameStart();
    b.view.setShake(0);
    const vm = deriveViewModel(sim);
    b.interp.push(vm);
    b.levelLights.reset(vm.hud.topEffectiveRow);
    b.loseBar.reset();
    b.celebration.stop();
    b.overlay.setCelebration(null);
  }

  /** Abandon the current match (if still live) and kick off a fresh seed. */
  const nextMatch = (): void => {
    match = new AiVsAiMatch(generateSeed(), left, right);
    boards.forEach((b, i) => resetBoard(b, match.sims[i]!));
    matchNo++;
    clock.reset();
    metaTicks = 0;
    paused = false;
    tallied = false;
    endWait = 0;
    celebAccum = 0;
    gameMusicOn = false;
    kickoffWait = attract ? TITLE_HOLD_TICKS : 0;
    if (!attract) {
      audio.resetCountdown();
      audio.fadeoutMusic(3000);
    }
  };

  const togglePause = (): void => {
    // Nothing to pause during the countdown or once the match is decided.
    if (!paused && (match.outcome !== null || metaTicks < COUNTDOWN_GATE_TICKS)) return;
    paused = !paused;
    if (paused) audio.pauseMusic();
    else audio.resumeMusic();
  };

  const fitToWindow = (): void => {
    const w = globalThis.innerWidth / 2;
    const h = globalThis.innerHeight;
    boards[0].view.resize(w, h);
    boards[1].view.resize(w, h);
  };
  fitToWindow();
  globalThis.addEventListener('resize', fitToWindow);

  // --- controls: a right-hand button column (works on touch) + keys ---------
  const buttons: HTMLButtonElement[] = [];
  const addButton = (text: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `position:fixed;top:${12 + 40 * buttons.length}px;right:12px;z-index:7;padding:6px 12px;opacity:.85`;
    btn.onclick = onClick;
    document.body.appendChild(btn);
    buttons.push(btn);
    return btn;
  };
  let speedBtn: HTMLButtonElement | null = null;
  const syncSpeedBtn = (): void => {
    if (speedBtn) speedBtn.textContent = `Speed ${SPEEDS[speedIdx]}×`;
  };
  const cycleSpeed = (): void => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    syncSpeedBtn();
  };
  // Attract mode is watch-only (any key starts play, handled by main.ts), so it
  // gets no controls and no tally.
  if (!attract) {
    addButton('Leave demo', onExit);
    addButton('Next match', nextMatch);
    speedBtn = addButton('', cycleSpeed);
    syncSpeedBtn();
  }

  // Running tally + match clock, centred between the boards.
  const scoreboard = document.createElement('div');
  scoreboard.style.cssText =
    'position:fixed;top:36px;left:50%;transform:translateX(-50%);z-index:6;pointer-events:none;' +
    'text-align:center;white-space:pre;font:600 14px system-ui,sans-serif;color:#e7ebf3;' +
    'font-variant-numeric:tabular-nums;text-shadow:0 1px 3px #000';
  if (!attract) document.body.appendChild(scoreboard);
  let scoreText = '';
  const renderScoreboard = (): void => {
    const secs = Math.floor(match.ticks / GC_STEPS_PER_SECOND);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const drawn = draws > 0 ? ` (${draws} drawn)` : '';
    const text =
      `${wins[0]} – ${wins[1]}${drawn}\n` +
      `match ${matchNo} · ${time} · ${SPEEDS[speedIdx]}×${paused ? ' · paused' : ''}`;
    if (text !== scoreText) {
      scoreText = text;
      scoreboard.textContent = text;
    }
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (e.code === 'Escape') onExit();
    else if (e.code === 'KeyN') nextMatch();
    else if (e.code === 'KeyF') cycleSpeed();
    else if (e.code === 'KeyP') togglePause();
  };
  if (!attract) globalThis.addEventListener('keydown', onKeyDown);

  /** The big per-board message: countdown / paused while live, the result after. */
  const messageFor = (side: number): MessageKind | null => {
    const outcome = match.outcome;
    if (outcome === null) {
      if (kickoffWait > 0) return null; // "3" waits for the title to lift
      return paused ? 'message_paused' : countdownMessage(metaTicks);
    }
    if (outcome === side) return 'message_winner';
    return outcome === 0 || outcome === 1 ? 'message_loser' : 'message_game_over';
  };

  let lastMs = performance.now();
  const frame = (nowMs: number): void => {
    if (disposed) return;
    // Always sample, so time spent paused or celebrating never bursts into catch-up.
    const due = clock.sample(nowMs);
    let stepped = 0;
    let gateTicks = 0;
    if (kickoffWait > 0) {
      // Attract mode: hold on the title card, then lift it and count down.
      kickoffWait -= due;
      if (kickoffWait <= 0) attract?.hideTitle();
    } else if (!paused && match.outcome === null) {
      // The countdown gate runs on wall time (so 3-2-1 and its beeps aren't
      // sped up); the rest of the due ticks play at the chosen speed.
      gateTicks = Math.min(due, Math.max(0, COUNTDOWN_GATE_TICKS - metaTicks));
      const total = (due - gateTicks) * SPEEDS[speedIdx]!;
      metaTicks += due;
      for (let t = 0; t < total; t++) {
        const done = match.step() !== null;
        stepped++;
        // Interpolation needs only the last two ticks: skip the grid walk for
        // catch-up ticks that would be discarded, but always capture the final one.
        if (t >= total - 2 || done) {
          boards.forEach((b, i) => b.interp.push(deriveViewModel(match.sims[i]!)));
        }
        if (done) break;
      }
    }

    if (!attract) audio.updateCountdown(metaTicks);
    if (!attract && !gameMusicOn && metaTicks >= COUNTDOWN_GATE_TICKS) {
      gameMusicOn = true;
      audio.playGame();
    }
    // Both boards are the show, so both are heard (attract mode only drains them).
    for (const sim of match.sims) {
      const cues = sim.drainSoundEvents();
      if (!attract) audio.playCues(cues);
    }

    const outcome = match.outcome;
    if (outcome !== null && !tallied) {
      tallied = true;
      if (outcome === 0 || outcome === 1) wins[outcome]++;
      else draws++;
      boards.forEach((b, i) => b.celebration.start(outcome === i ? 'win' : 'loss'));
      if (!attract) {
        if (outcome === 0 || outcome === 1) audio.playYouWin();
        else audio.playGameOver();
      }
    }

    const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
    lastMs = nowMs;

    // Celebrations (and the wait for the next match) run on wall-clock ticks.
    let celebSteps = 0;
    if (tallied && !paused) {
      celebAccum += dtTicks;
      while (celebAccum >= 1) {
        for (const b of boards) b.celebration.tick();
        celebAccum -= 1;
        celebSteps++;
      }
      endWait += dtTicks;
    }

    const alpha = outcome !== null || paused ? 1 : clock.alpha;
    boards.forEach((b, i) => {
      const sim = match.sims[i]!;
      const impacts = sim.drainImpactEvents();
      for (const ev of sim.drainSignEvents()) b.signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
      for (const imp of impacts) b.spring.notifyImpact(imp.height, imp.width);
      for (let t = 0; t < stepped; t++) b.spring.timeStep();
      b.view.setShake(b.spring.offsetCells);
      for (const ev of sim.drainSparkEvents())
        b.sparkles.spawnSparks(ev.x, ev.y, ev.flavor, ev.count);
      for (const ev of sim.drainMoteEvents())
        b.sparkles.spawnMote(ev.x, ev.y, ev.level, ev.sibling);
      if (tallied) {
        b.overlay.setCelebration(b.celebration.view);
        for (const spawn of b.celebration.drainSparkSpawns()) {
          b.sparkles.spawnCelebrationSpark(spawn.source, spawn.color);
        }
      }
      b.sparkles.advance(stepped + celebSteps);
      b.sparkles.sync();
      b.signs.update(dtTicks);
      b.overlay.show(messageFor(i));
      b.overlay.update(dtTicks);
      const vm = b.interp.sample(alpha);
      b.view.update(vm);
      b.decals.update(vm.garbage);
      b.loseBar.update(stepped, sim.creep.creep_freeze, sim.creep.loss_alarm);
      b.levelLights.update(gateTicks + stepped, vm.hud.topEffectiveRow, outcome === null, impacts);
      b.view.render();
    });
    renderScoreboard();

    // Attract mode brings the title back once the celebration has played, and
    // resets for the next match behind it once it's fully faded in.
    if (attract && endWait >= TITLE_RETURN_TICKS) attract.showTitle();
    const nextAt = attract ? TITLE_RETURN_TICKS + TITLE_FADE_TICKS : NEXT_MATCH_DELAY_TICKS;
    if (endWait >= nextAt) nextMatch();
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
      for (const btn of buttons) btn.remove();
      scoreboard.remove();
      for (const b of boards) {
        b.overlay.dispose();
        b.loseBar.dispose();
        b.view.dispose();
        b.container.remove();
      }
      if (hudEl) hudEl.textContent = '';
    },
  };
}

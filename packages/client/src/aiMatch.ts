/**
 * aiMatch.ts — a local human-vs-AI match with two *visible* boards.
 *
 * You play the left board; the {@link AiController} drives a second `GameSim` on
 * the right, so its moves are fully visible. The two are cross-wired through the
 * garbage seam (each side's outgoing garbage lands on the other), exactly like
 * netplay — the only difference is the opponent's inputs come from the bot
 * instead of the wire. Both sims share a seed so the boards start identical.
 * You lose if your board tops out; you win if the AI's does.
 *
 * Reuses the per-board view stack (board, signs, sparkles, lose bar, level
 * lights, spring) plus the countdown, celebration, and audio. Deterministic
 * core; DOM/WebGL glue here.
 */

import {
  AiController,
  GameSim,
  GC_STEPS_PER_SECOND,
  generateSeed,
  type AiDifficultyLevel,
} from '@crack-attack/core';
import { KeyboardInput } from './input/keyboard.js';
import { mountTouchControls } from './input/touchControls.js';
import { BoardView } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { HudView } from './render/hudView.js';
import { LevelLightsView } from './render/levelLightsView.js';
import { LoseBarView } from './render/loseBarView.js';
import { SignsView } from './render/signsView.js';
import { MessageOverlay } from './render/messageOverlay.js';
import { SparklesView } from './render/sparklesView.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { COUNTDOWN_GATE_TICKS, countdownMessage } from './view/messages.js';
import { Celebration } from './view/celebration.js';
import { Spring } from './view/spring.js';
import { ViewInterpolator } from './view/viewInterpolator.js';
import type { AudioManager } from './audio/audioManager.js';

const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
const MAX_SIGN_DT_TICKS = 10;

export interface AiMatchHandle {
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
}

/** Start a local match: you on the left, an AI-driven board on the right. */
export function bootAiMatch(
  app: HTMLElement,
  hudEl: HTMLElement | null,
  difficulty: AiDifficultyLevel,
  audio: AudioManager,
  onExit: () => void,
): AiMatchHandle {
  const clock = new FixedTimestep();
  const input = new KeyboardInput();
  const hud = hudEl ? new HudView(hudEl) : null;
  const celebration = new Celebration();

  let seed = generateSeed();
  let humanSim = new GameSim(seed);
  let aiSim = new GameSim(seed);
  let ai = new AiController(difficulty);
  crossWire();

  // --- Replay capture: the human's per-tick inputs (sparse — only nonzero
  // commands), in the replay-check ActionEvent shape. The AI side needs no
  // recording: it regenerates deterministically from (seed, difficulty).
  let recTicks = 0;
  let recActions: { tick: number; command: number }[] = [];

  const saveReplay = (): void => {
    const replay = {
      kind: 'crack-attack-vs-ai-replay',
      version: 1,
      seed,
      difficulty,
      ticks: recTicks,
      actions: recActions,
    };
    const blob = new Blob([JSON.stringify(replay)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `replay-vs-${difficulty}-${seed}.json`;
    link.click();
    // Revoking synchronously can cancel the download in some browsers — give
    // the navigation ample time to start before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const boards = [makeBoard(humanSim, 'YOU', 0), makeBoard(aiSim, `CPU · ${difficulty}`, 1)] as [
    Board,
    Board,
  ];
  const overlay = new MessageOverlay(app);

  let disposed = false;
  let rafId = 0;
  let metaTicks = 0;
  let paused = false;
  let outcome: 'win' | 'loss' | null = null;
  let gameMusicOn = false;
  let endMusicOn = false;
  let celebAccum = 0;

  audio.resetCountdown();
  audio.fadeoutMusic(3000);

  /** Cross-wire the two sims' garbage ports (netplay's seam, but local). */
  function crossWire(): void {
    const link = (from: GameSim, to: GameSim): void => {
      from.garbageGenerator.outSink = {
        sendGarbage: (h, w, f) => to.garbageGenerator.addToQueue(h, w, f, from.clock.time_step),
        sendSpecialGarbage: (f) => to.garbageGenerator.addToQueue(1, 1, f, from.clock.time_step),
      };
    };
    link(humanSim, aiSim);
    link(aiSim, humanSim);
  }

  function makeBoard(sim: GameSim, label: string, side: 0 | 1): Board {
    const container = document.createElement('div');
    container.style.cssText = `position:absolute;top:0;bottom:0;width:50%;${side === 0 ? 'left:0' : 'right:0'}`;
    app.appendChild(container);

    const tag = document.createElement('div');
    tag.textContent = label;
    tag.style.cssText =
      'position:absolute;top:10px;left:0;right:0;text-align:center;z-index:2;pointer-events:none;' +
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
  }

  const restart = (): void => {
    seed = generateSeed();
    humanSim = new GameSim(seed);
    aiSim = new GameSim(seed);
    ai = new AiController(difficulty);
    crossWire();
    recTicks = 0;
    recActions = [];
    clock.reset();
    input.clear();
    resetBoard(boards[0], humanSim);
    resetBoard(boards[1], aiSim);
    metaTicks = 0;
    paused = false;
    outcome = null;
    gameMusicOn = false;
    endMusicOn = false;
    celebAccum = 0;
    celebration.stop();
    overlay.setCelebration(null);
    audio.resetCountdown();
    audio.fadeoutMusic(3000);
  };

  const fitToWindow = (): void => {
    const w = globalThis.innerWidth / 2;
    const h = globalThis.innerHeight;
    boards[0].view.resize(w, h);
    boards[1].view.resize(w, h);
  };
  fitToWindow();
  globalThis.addEventListener('resize', fitToWindow);

  const exitBtn = document.createElement('button');
  exitBtn.textContent = 'Leave match';
  exitBtn.style.cssText =
    'position:fixed;top:12px;right:12px;z-index:7;padding:6px 12px;opacity:.85';
  exitBtn.onclick = onExit;
  document.body.appendChild(exitBtn);

  // Appears once the match ends: download the game as a replay JSON (your
  // inputs + the seed; the AI regenerates deterministically). Feed it to
  // tools/replay-analyze to diff your play against the planner's.
  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save replay';
  saveBtn.style.cssText =
    'position:fixed;top:52px;right:12px;z-index:7;padding:6px 12px;opacity:.85;display:none';
  saveBtn.onclick = saveReplay;
  document.body.appendChild(saveBtn);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyR') {
      restart();
      return;
    }
    if (e.code === 'KeyP' && !e.repeat) {
      if (!paused) {
        if (outcome || humanSim.creep.creep_freeze || metaTicks < COUNTDOWN_GATE_TICKS) return;
        paused = true;
        audio.pauseMusic();
      } else {
        paused = false;
        audio.resumeMusic();
      }
      return;
    }
    if (input.handles(e.code)) {
      input.press(e.code);
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => input.release(e.code);
  const onBlur = (): void => input.clear();
  globalThis.addEventListener('keydown', onKeyDown);
  globalThis.addEventListener('keyup', onKeyUp);
  globalThis.addEventListener('blur', onBlur);

  const touch = mountTouchControls({
    press: (code) => input.press(code),
    release: (code) => input.release(code),
    restart,
  });

  let lastMs = performance.now();
  const frame = (nowMs: number): void => {
    if (disposed) return;
    let stepped = 0;
    let gateTicks = 0;
    if (paused) {
      clock.sample(nowMs);
    } else if (!outcome) {
      const steps = clock.sample(nowMs);
      for (let s = 0; s < steps; s++) {
        if (metaTicks < COUNTDOWN_GATE_TICKS) {
          metaTicks++;
          gateTicks++;
          continue;
        }
        const act = input.actionState();
        recTicks++;
        if (act.state !== 0) recActions.push({ tick: recTicks, command: act.state });
        humanSim.step(act);
        aiSim.step(ai.decide(aiSim));
        stepped++;
        metaTicks++;
        if (humanSim.lost) outcome = 'loss';
        else if (aiSim.lost) outcome = 'win';
        if (s >= steps - 2 || outcome) {
          boards[0].interp.push(deriveViewModel(humanSim));
          boards[1].interp.push(deriveViewModel(aiSim));
        }
        if (outcome) break;
      }
    }

    // Audio: countdown beeps, game music at GO, win/loss stinger.
    audio.updateCountdown(metaTicks);
    if (!gameMusicOn && metaTicks >= COUNTDOWN_GATE_TICKS) {
      gameMusicOn = true;
      audio.playGame();
    }
    // Your board's sound cues (the AI's board plays silently, like a netplay opponent).
    audio.playCues(humanSim.drainSoundEvents());
    aiSim.drainSoundEvents();
    if (outcome && !endMusicOn) {
      endMusicOn = true;
      if (outcome === 'win') audio.playYouWin();
      else audio.playGameOver();
    }
    saveBtn.style.display = outcome ? '' : 'none';

    const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
    lastMs = nowMs;

    // Big overlay + celebration (on your board when you win).
    overlay.show(
      outcome === 'win'
        ? 'message_winner'
        : outcome === 'loss'
          ? 'message_loser'
          : paused
            ? 'message_paused'
            : countdownMessage(metaTicks),
    );
    overlay.update(dtTicks);
    let celebSteps = 0;
    if (outcome) {
      if (!celebration.active) celebration.start(outcome);
      celebAccum += dtTicks;
      while (celebAccum >= 1) {
        celebration.tick();
        celebAccum -= 1;
        celebSteps++;
      }
      overlay.setCelebration(celebration.view);
      for (const spawn of celebration.drainSparkSpawns()) {
        boards[0].sparkles.spawnCelebrationSpark(spawn.source, spawn.color);
      }
    }

    const sims = [humanSim, aiSim];
    const alpha = outcome || paused ? 1 : clock.alpha;
    boards.forEach((b, i) => {
      const sim = sims[i]!;
      const impacts = sim.drainImpactEvents();
      for (const ev of sim.drainSignEvents()) b.signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
      for (const imp of impacts) b.spring.notifyImpact(imp.height, imp.width);
      for (let t = 0; t < stepped; t++) b.spring.timeStep();
      b.view.setShake(b.spring.offsetCells);
      for (const ev of sim.drainSparkEvents())
        b.sparkles.spawnSparks(ev.x, ev.y, ev.flavor, ev.count);
      for (const ev of sim.drainMoteEvents())
        b.sparkles.spawnMote(ev.x, ev.y, ev.level, ev.sibling);
      // The winner's board also runs the celebration fireworks.
      b.sparkles.advance(stepped + (i === 0 ? celebSteps : 0));
      b.sparkles.sync();
      b.signs.update(dtTicks);
      const vm = b.interp.sample(alpha);
      b.view.update(vm);
      b.decals.update(vm.garbage);
      b.loseBar.update(stepped, sim.creep.creep_freeze, sim.creep.loss_alarm);
      b.levelLights.update(gateTicks + stepped, vm.hud.topEffectiveRow, !outcome, impacts);
      b.view.render();
      if (i === 0) hud?.update(vm.hud);
    });

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
      exitBtn.remove();
      saveBtn.remove();
      overlay.dispose();
      for (const b of boards) {
        b.loseBar.dispose();
        b.view.dispose();
        b.container.remove();
      }
      if (hudEl) hudEl.textContent = '';
    },
  };
}

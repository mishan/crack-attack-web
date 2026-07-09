/**
 * @crack-attack/client — browser entry point.
 *
 * Wires the platform layers around the deterministic core into a playable solo
 * board: a {@link FixedTimestep} advances a `GameSim` at 50 Hz from real time,
 * {@link KeyboardInput} feeds it the player's actions, {@link deriveViewModel}
 * turns each tick's sim state into sprites, {@link ViewInterpolator} smooths the
 * motion between ticks by the render `alpha`, and {@link BoardView} draws it.
 *
 * The sim is authoritative and deterministic; everything here is replaceable
 * platform glue (and stays out of `packages/core`, which must not touch the DOM).
 */

import { GameSim, GC_STEPS_PER_SECOND } from '@crack-attack/core';
import { KeyboardInput } from './input/keyboard.js';
import { BoardView } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { HudView } from './render/hudView.js';
import { SignsView } from './render/signsView.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { ViewInterpolator } from './view/viewInterpolator.js';

const SEED = 0x1a2b3c4d;
const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
/** Cap sign advance per frame so a long stall (tab refocus) doesn't warp them away. */
const MAX_SIGN_DT_TICKS = 10;

function boot(): void {
  const app = document.getElementById('app');
  const hudEl = document.getElementById('hud');
  if (!app) throw new Error('missing #app container');

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
  const hud = hudEl ? new HudView(hudEl) : null;

  const fitToWindow = (): void => view.resize(globalThis.innerWidth, globalThis.innerHeight);
  fitToWindow();
  globalThis.addEventListener('resize', fitToWindow);

  // --- input ---------------------------------------------------------------
  globalThis.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'KeyR') {
      sim = new GameSim(SEED); // fresh deterministic game
      clock.reset();
      interp.reset();
      interp.push(deriveViewModel(sim));
      signs.clear();
      decals.clear();
      input.clear();
      return;
    }
    if (input.handles(e.code)) {
      input.press(e.code);
      e.preventDefault();
    }
  });
  globalThis.addEventListener('keyup', (e: KeyboardEvent) => input.release(e.code));
  // Don't let inputs stick if focus leaves the tab mid-press.
  globalThis.addEventListener('blur', () => input.clear());

  // --- loop ----------------------------------------------------------------
  let lastMs = performance.now();
  const frame = (nowMs: number): void => {
    const steps = clock.sample(nowMs);
    for (let s = 0; s < steps; s++) {
      sim.step(input.actionState());
      // Interpolation only needs the last two ticks, so under catch-up (steps > 1)
      // skip the expensive grid-walk for the intermediate ticks that get discarded.
      if (s >= steps - 2) interp.push(deriveViewModel(sim));
    }

    // Spawn reward signs for the combos that fired across this frame's ticks.
    for (const ev of sim.drainSignEvents()) signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);

    // Signs float on wall-clock time so they stay smooth between sim ticks.
    const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
    lastMs = nowMs;
    signs.update(dtTicks);

    const vm = interp.sample(clock.alpha); // blend the last two ticks
    view.update(vm);
    decals.update(vm.garbage);
    view.render();
    hud?.update(vm.hud);

    globalThis.requestAnimationFrame(frame);
  };
  globalThis.requestAnimationFrame(frame);
}

boot();

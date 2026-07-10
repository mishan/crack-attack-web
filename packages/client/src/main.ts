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
import { mountTouchControls } from './input/touchControls.js';
import { BoardView, DEFAULT_RENDER_TUNING } from './render/boardView.js';
import { GarbageDecalView } from './render/garbageDecalView.js';
import { HudView } from './render/hudView.js';
import { mountRenderTuner } from './render/renderTuner.js';
import { LevelLightsView } from './render/levelLightsView.js';
import { SignsView } from './render/signsView.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { ViewInterpolator } from './view/viewInterpolator.js';

const SEED = 0x1a2b3c4d;
const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
/** Cap sign advance per frame so a long stall (tab refocus) doesn't warp them away. */
const MAX_SIGN_DT_TICKS = 10;

/**
 * Mode dispatch: `?net` boots the head-to-head netplay shell (Phase 4);
 * `?relay=ws://host:port` overrides the relay URL. Default is the solo game.
 */
function boot(): void {
  const app = document.getElementById('app');
  const hudEl = document.getElementById('hud');
  if (!app) throw new Error('missing #app container');

  const params = new URLSearchParams(globalThis.location.search);
  if (params.has('net')) {
    // Match the page's security context: an https page can only open wss
    // sockets (mixed-content rules), so default the scheme accordingly.
    const scheme = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
    const relayUrl = params.get('relay') ?? `${scheme}://${globalThis.location.hostname}:8080`;
    const help = document.getElementById('help');
    if (help) {
      help.textContent = '←→↑↓ move · Z / Space swap · X raise · R ready/rematch · Esc concede';
    }
    void import('./netplay.js').then((m) => m.bootNetplay(app, hudEl, relayUrl));
    return;
  }
  bootSolo(app, hudEl);
}

function bootSolo(app: HTMLElement, hudEl: HTMLElement | null): void {
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
  const hud = hudEl ? new HudView(hudEl) : null;

  // Temporary lighting/material tuner — open with `?tune` in the URL.
  if (new URLSearchParams(globalThis.location.search).has('tune')) {
    mountRenderTuner(view, DEFAULT_RENDER_TUNING);
  }

  const fitToWindow = (): void => view.resize(globalThis.innerWidth, globalThis.innerHeight);
  fitToWindow();
  globalThis.addEventListener('resize', fitToWindow);

  // --- input ---------------------------------------------------------------
  const restart = (): void => {
    sim = new GameSim(SEED); // fresh deterministic game
    clock.reset();
    interp.reset();
    interp.push(deriveViewModel(sim));
    signs.clear();
    decals.clear();
    input.clear();
  };

  globalThis.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'KeyR') {
      restart();
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
    // Advance the sim only while the game is live. On a loss we stop stepping, so
    // the clock (and thus the HUD timer) and the board freeze on the final tick
    // until the player restarts.
    if (!sim.lost) {
      const steps = clock.sample(nowMs);
      for (let s = 0; s < steps; s++) {
        sim.step(input.actionState());
        // Interpolation only needs the last two ticks, so under catch-up (steps > 1)
        // skip the expensive grid-walk for the intermediate ticks that get
        // discarded — but always capture the tick a loss lands on.
        if (s >= steps - 2 || sim.lost) interp.push(deriveViewModel(sim));
        if (sim.lost) break;
      }
      // Spawn reward signs for the combos that fired across this frame's ticks.
      for (const ev of sim.drainSignEvents()) signs.spawn(ev.gridX, ev.gridY, ev.kind, ev.level);
    }

    // Signs float on wall-clock time (and keep fading out after a loss).
    const dtTicks = Math.min(MAX_SIGN_DT_TICKS, (nowMs - lastMs) / MS_PER_TICK);
    lastMs = nowMs;
    signs.update(dtTicks);

    // After a loss show the frozen final tick (alpha 1) rather than interpolating
    // toward a state the sim will never reach.
    const vm = interp.sample(sim.lost ? 1 : clock.alpha);
    view.update(vm);
    decals.update(vm.garbage);
    levelLights.update(vm.hud.topEffectiveRow);
    view.render();
    hud?.update(vm.hud);

    globalThis.requestAnimationFrame(frame);
  };
  globalThis.requestAnimationFrame(frame);
}

boot();

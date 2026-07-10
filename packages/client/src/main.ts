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
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';
import { ViewInterpolator } from './view/viewInterpolator.js';

const SEED = 0x1a2b3c4d;
const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
/** Cap sign advance per frame so a long stall (tab refocus) doesn't warp them away. */
const MAX_SIGN_DT_TICKS = 10;

const SOLO_HELP = '←→↑↓ move · Z / Space swap · X raise · R restart';
const NET_HELP =
  '←→↑↓ move · Z / Space swap · X raise · R ready/rematch · Esc concede/stop watching';

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

function boot(): void {
  const app = document.getElementById('app');
  const hudEl = document.getElementById('hud');
  if (!app) throw new Error('missing #app container');

  const params = new URLSearchParams(globalThis.location.search);
  const relayUrl = resolveRelayUrl(params);
  const help = document.getElementById('help');

  let current: ModeHandle | null = null;
  const enter = (mode: 'solo' | 'net'): void => {
    current?.dispose();
    current = null;
    if (hudEl) hudEl.textContent = '';
    if (help) help.textContent = mode === 'net' ? NET_HELP : SOLO_HELP;
    if (mode === 'net') {
      void import('./netplay.js').then((m) => {
        current = m.bootNetplay(app, hudEl, relayUrl, () => enter('solo'));
      });
    } else {
      current = bootSolo(app, hudEl, () => enter('net'));
    }
  };

  enter(params.has('net') ? 'net' : 'solo');
}

function bootSolo(
  app: HTMLElement,
  hudEl: HTMLElement | null,
  onPlayOnline: () => void,
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
  const hud = hudEl ? new HudView(hudEl) : null;
  let disposed = false;
  let rafId = 0;

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
    interp.push(deriveViewModel(sim));
    signs.clear();
    decals.clear();
    input.clear();
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
      view.dispose(); // release the WebGL context (browsers cap them)
    },
  };
}

boot();

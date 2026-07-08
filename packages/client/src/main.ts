/**
 * @crack-attack/client — browser entry point.
 *
 * Wires the platform layers around the deterministic core into a playable solo
 * board: a {@link FixedTimestep} advances a `GameSim` at 50 Hz from real time,
 * {@link KeyboardInput} feeds it the player's actions, {@link deriveViewModel}
 * turns each frame's sim state into sprites, and {@link BoardView} draws them.
 *
 * The sim is authoritative and deterministic; everything here is replaceable
 * platform glue (and stays out of `packages/core`, which must not touch the DOM).
 */

import { GameSim } from '@crack-attack/core';
import { KeyboardInput } from './input/keyboard.js';
import { BoardView } from './render/boardView.js';
import { FixedTimestep } from './sim/fixedTimestep.js';
import { deriveViewModel } from './view/boardViewModel.js';

const SEED = 0x1a2b3c4d;

function boot(): void {
  const app = document.getElementById('app');
  const hudEl = document.getElementById('hud');
  if (!app) throw new Error('missing #app container');

  let sim = new GameSim(SEED);
  const clock = new FixedTimestep();
  const input = new KeyboardInput();
  // One grid walk to read the board dimensions the renderer needs.
  const initial = deriveViewModel(sim);
  const view = new BoardView(app, initial.width, initial.visibleHeight);

  const fitToWindow = (): void => view.resize(globalThis.innerWidth, globalThis.innerHeight);
  fitToWindow();
  globalThis.addEventListener('resize', fitToWindow);

  // --- input ---------------------------------------------------------------
  globalThis.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code === 'KeyR') {
      sim = new GameSim(SEED); // fresh deterministic game
      clock.reset();
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
  const frame = (nowMs: number): void => {
    const steps = clock.sample(nowMs);
    for (let s = 0; s < steps; s++) sim.step(input.actionState());

    const vm = deriveViewModel(sim, clock.alpha);
    view.update(vm);
    view.render();

    if (hudEl) {
      const danger = Math.round(vm.hud.dangerFraction * 100);
      hudEl.textContent =
        `tick ${vm.hud.tick}\n` +
        `danger ${danger}%\n` +
        (vm.hud.dyingCount ? `popping ${vm.hud.dyingCount}\n` : '') +
        (vm.hud.lost ? 'LOST — press R' : '');
    }

    globalThis.requestAnimationFrame(frame);
  };
  globalThis.requestAnimationFrame(frame);
}

boot();

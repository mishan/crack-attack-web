/**
 * loseBarCanvas.ts — the lose bar as a HUD element, drawn like the reference.
 *
 * The solo HUD shows the lose bar where the original's side column had it
 * (DrawExternalCandy.cxx), rendered onto a small canvas from the reference's
 * own shaded-tube texture and colour sweep (`view/loseBarTexture.ts`), driven by
 * the same {@link LoseBarState} as the in-scene {@link LoseBarView} it replaces
 * there — and with the same interface: `reset` per game, `update` with the
 * ticks stepped each frame.
 */

import { LoseBarState } from '../view/loseBar.js';
import {
  LOSEBAR_ASPECT,
  LOSEBAR_TEX_S,
  LOSEBAR_TEX_T,
  type LoseBarTexture,
  loseBarColorAt,
  loseBarTexture,
} from '../view/loseBarTexture.js';

/** The tube texture, computed once on first use and shared. */
let texture: LoseBarTexture | null = null;

export class LoseBarCanvas {
  readonly element: HTMLCanvasElement;
  private readonly state = new LoseBarState();
  /** The bar at texture resolution; scaled (smoothly, as GL_LINEAR) onto `element`. */
  private readonly texels: HTMLCanvasElement;
  /** What was last drawn, so an unchanged bar isn't redrawn every frame. */
  private drawn = '';

  /** A bar `width` CSS px long (its height follows the reference's proportions). */
  constructor(width: number) {
    const height = Math.round(width * LOSEBAR_ASPECT);
    const dpr = globalThis.devicePixelRatio || 1;
    this.element = document.createElement('canvas');
    this.element.width = Math.round(width * dpr);
    this.element.height = Math.round(height * dpr);
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    this.element.setAttribute('role', 'img');
    this.element.setAttribute('aria-label', 'Lose bar');
    this.texels = document.createElement('canvas');
    this.texels.width = LOSEBAR_TEX_S;
    this.texels.height = LOSEBAR_TEX_T;
    this.sync();
  }

  /** Reset for a new game (LoseBar::initialize/gameStart). */
  reset(): void {
    this.state.gameStart();
    this.sync();
  }

  /**
   * Advance the bar by the sim ticks stepped this frame, from the Creep loss
   * state (as {@link LoseBarView.update}), then redraw if it changed.
   */
  update(steppedTicks: number, creepFreeze: boolean, lossAlarm: number): void {
    for (let t = 0; t < steppedTicks; t++) this.state.tick(creepFreeze, lossAlarm);
    this.sync();
  }

  private sync(): void {
    const c1 = this.state.color1();
    const c2 = this.state.color2();
    const bar = this.state.bar;
    const key = `${c1.join()}|${c2.join()}|${bar}`;
    if (key === this.drawn) return;
    const tctx = this.texels.getContext('2d');
    const ctx = this.element.getContext('2d');
    if (!tctx || !ctx) return;
    this.drawn = key;

    // GL_BLEND with a white env colour: rgb = colour·(1 − L) + L, alpha = A.
    texture ??= loseBarTexture();
    const img = tctx.createImageData(LOSEBAR_TEX_S, LOSEBAR_TEX_T);
    for (let s = 0; s < LOSEBAR_TEX_S; s++) {
      const [r, g, b] = loseBarColorAt((s + 0.5) / LOSEBAR_TEX_S, bar, c1, c2);
      for (let t = 0; t < LOSEBAR_TEX_T; t++) {
        const i = t * LOSEBAR_TEX_S + s;
        const l = texture.lumin[i]!;
        img.data[i * 4] = Math.round((r * (1 - l) + l) * 255);
        img.data[i * 4 + 1] = Math.round((g * (1 - l) + l) * 255);
        img.data[i * 4 + 2] = Math.round((b * (1 - l) + l) * 255);
        img.data[i * 4 + 3] = Math.round(texture.alpha[i]! * 255);
      }
    }
    tctx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, this.element.width, this.element.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.texels, 0, 0, this.element.width, this.element.height);
  }
}

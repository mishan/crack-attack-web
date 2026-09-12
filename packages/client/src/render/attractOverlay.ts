/**
 * attractOverlay.ts — the attract mode's DOM layer: a full-screen title card
 * (the reference `logo.png` over the page background, with a blinking PRESS
 * ANY KEY prompt) and, while a demo match plays, the same prompt at the bottom
 * of the screen.
 *
 * The title fades in and out over the running demo, so a match can reset
 * behind it. The overlay sits above the boards and their messages but below
 * the audio controls and modals (z-index 20), which stay usable.
 */

import { GC_STEPS_PER_SECOND } from '@crack-attack/core';
import { TITLE_FADE_TICKS } from '../view/attract.js';
import { FONT0 } from '../view/bitmapFont.js';
import { BitmapLabel } from './bitmapText.js';

/** Title card fade, in ms (CSS transition). */
const FADE_MS = (TITLE_FADE_TICKS * 1000) / GC_STEPS_PER_SECOND;
/** One on/off blink of the prompt, in ms. */
const BLINK_MS = 1600;

export class AttractOverlay {
  private readonly title: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly blinks: Animation[] = [];

  /** Mounted with the title card showing. `touch` words the prompt for taps. */
  constructor(touch: boolean) {
    const prompt = touch ? 'TAP TO PLAY' : 'PRESS ANY KEY TO PLAY';

    this.title = document.createElement('div');
    this.title.style.cssText =
      'position:fixed;inset:0;z-index:15;display:flex;flex-direction:column;align-items:center;' +
      `justify-content:center;gap:4vmin;background:#0b0d12;transition:opacity ${FADE_MS}ms ease`;
    const logo = document.createElement('img');
    logo.src = 'textures/logo.png';
    logo.alt = 'Crack Attack!';
    logo.draggable = false;
    logo.style.cssText = 'width:min(70vmin,320px);height:auto;user-select:none';
    this.title.append(logo, this.makePrompt(prompt, 28));
    document.body.appendChild(this.title);

    this.banner = document.createElement('div');
    this.banner.style.cssText =
      'position:fixed;left:0;right:0;bottom:40px;z-index:8;display:flex;justify-content:center;' +
      'pointer-events:none;filter:drop-shadow(0 1px 3px #000)';
    this.banner.append(this.makePrompt(prompt, 22));
    document.body.appendChild(this.banner);
  }

  /** Fade the title card in over the demo. */
  showTitle(): void {
    this.title.style.opacity = '1';
    this.title.style.pointerEvents = 'auto';
  }

  /** Fade the title card out, revealing the demo (the bottom prompt stays). */
  hideTitle(): void {
    this.title.style.opacity = '0';
    this.title.style.pointerEvents = 'none';
  }

  /** Whether `node` is part of the overlay (a click on it starts play). */
  contains(node: Node): boolean {
    return this.title.contains(node) || this.banner.contains(node);
  }

  dispose(): void {
    for (const blink of this.blinks) blink.cancel();
    this.title.remove();
    this.banner.remove();
  }

  /** A blinking bitmap-font prompt line. */
  private makePrompt(text: string, height: number): HTMLElement {
    const label = new BitmapLabel(FONT0, { height, color: '#e7ebf3' });
    label.setText(text);
    // Mostly on, briefly off — the arcade PRESS START blink.
    const blink = label.element.animate(
      [
        { opacity: 1 },
        { opacity: 1, offset: 0.6 },
        { opacity: 0.1, offset: 0.7 },
        { opacity: 0.1 },
      ],
      { duration: BLINK_MS, iterations: Infinity },
    );
    this.blinks.push(blink);
    return label.element;
  }
}

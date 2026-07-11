/**
 * messageOverlay.ts — the big centered message textures (countdown, GAME
 * OVER, WINNER/LOSER, WAITING), drawn as a DOM overlay.
 *
 * The reference draws these as textured quads centered above the board
 * (DrawMessages.cxx:86-106), pulsing their alpha (obj_messages.cxx). A DOM
 * <img> reproduces that with far less plumbing than a scene sprite, sits
 * naturally over one board or the whole window, and disposes trivially on
 * mode switches. Pixel art is scaled with `image-rendering: pixelated`, like
 * the era-appropriate look of the originals.
 */

import { messagePulseAlpha, type MessageKind } from '../view/messages.js';
import type { CelebrationView } from '../view/celebration.js';

/** Display width per message, as a fraction of the container's width. */
const WIDTHS: Record<MessageKind, number> = {
  count_down_3: 0.14,
  count_down_2: 0.14,
  count_down_1: 0.14,
  count_down_go: 0.28,
  message_game_over: 0.5,
  message_winner: 0.5,
  message_loser: 0.5,
  message_waiting: 0.45,
  message_paused: 0.45,
};

/** Base transform (centering) and whitening filter for the message image. */
const BASE_TRANSFORM = 'translate(-50%,-50%)';
const WHITEN = 'brightness(0) invert(1)';

export class MessageOverlay {
  private readonly container: HTMLElement;
  private readonly img: HTMLImageElement;
  /** Black board-dim veil for the end-of-match celebration. */
  private readonly veil: HTMLElement;
  private current: MessageKind | null = null;
  private pulseTicks = 0;
  private celebrating = false;

  /** `container` should be positioned (the overlay centers within it). */
  constructor(container: HTMLElement) {
    this.container = container;

    this.veil = document.createElement('div');
    this.veil.style.cssText =
      'position:absolute;inset:0;z-index:5;pointer-events:none;background:#000;opacity:0';
    container.appendChild(this.veil);

    this.img = document.createElement('img');
    // brightness(0) invert(1): the reference loads these PNGs as pure ALPHA
    // masks and paints the quad white (TextureLoader::loadImageAlpha keeps
    // only channel 3; DrawMessages.cxx colors 1,1,1,pulse). The files' RGB is
    // black, so an <img> would render black glyphs — force every opaque pixel
    // white and let the alpha channel keep doing the masking.
    this.img.style.cssText =
      `position:absolute;left:50%;top:38%;transform:${BASE_TRANSFORM};` +
      'z-index:6;display:none;pointer-events:none;image-rendering:pixelated;' +
      `user-select:none;filter:${WHITEN}`;
    this.img.alt = '';
    container.appendChild(this.img);
  }

  /** Show `kind` (restarting the pulse when the message changes), or hide on null. */
  show(kind: MessageKind | null): void {
    if (kind === this.current) return;
    this.current = kind;
    if (!kind) {
      this.img.style.display = 'none';
      return;
    }
    this.pulseTicks = 0;
    this.img.src = `textures/messages/${kind}.png`;
    this.img.style.width = `${WIDTHS[kind] * 100}%`;
    this.img.style.display = 'block';
    this.img.style.opacity = String(messagePulseAlpha(0));
  }

  /** Advance the alpha pulse by `dtTicks` (wall-clock ticks, like the signs). */
  update(dtTicks: number): void {
    if (!this.current || this.celebrating) return; // celebration drives its own opacity
    this.pulseTicks += dtTicks;
    this.img.style.opacity = String(messagePulseAlpha(this.pulseTicks));
  }

  /**
   * Drive the end-of-match celebration on the current message: dim the board,
   * and scale / drop / brighten the message per the {@link CelebrationView}.
   * Pass `null` to end the celebration (restores the normal pulse).
   */
  setCelebration(view: CelebrationView | null): void {
    if (!view) {
      if (!this.celebrating) return;
      this.celebrating = false;
      this.veil.style.opacity = '0';
      this.img.style.transform = BASE_TRANSFORM;
      this.img.style.filter = WHITEN;
      return;
    }
    this.celebrating = true;
    this.veil.style.opacity = String(view.boardDim);
    // Drop is a fraction of the container height (message falls in from above).
    const dropPx = view.dropFraction * this.container.clientHeight * 0.45;
    this.img.style.transform = `${BASE_TRANSFORM} translateY(${-dropPx}px) scale(${view.scale})`;
    this.img.style.opacity = String(view.opacity);
    // The win strobe reads as a white glow pulse over the already-white message.
    this.img.style.filter =
      view.flash > 0 ? `${WHITEN} drop-shadow(0 0 ${view.flash * 18}px #fff)` : WHITEN;
  }

  dispose(): void {
    this.img.remove();
    this.veil.remove();
  }
}

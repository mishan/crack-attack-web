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
};

export class MessageOverlay {
  private readonly img: HTMLImageElement;
  private current: MessageKind | null = null;
  private pulseTicks = 0;

  /** `container` should be positioned (the overlay centers within it). */
  constructor(container: HTMLElement) {
    this.img = document.createElement('img');
    // brightness(0) invert(1): the reference loads these PNGs as pure ALPHA
    // masks and paints the quad white (TextureLoader::loadImageAlpha keeps
    // only channel 3; DrawMessages.cxx colors 1,1,1,pulse). The files' RGB is
    // black, so an <img> would render black glyphs — force every opaque pixel
    // white and let the alpha channel keep doing the masking.
    this.img.style.cssText =
      'position:absolute;left:50%;top:38%;transform:translate(-50%,-50%);' +
      'z-index:6;display:none;pointer-events:none;image-rendering:pixelated;' +
      'user-select:none;filter:brightness(0) invert(1)';
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
    if (!this.current) return;
    this.pulseTicks += dtTicks;
    this.img.style.opacity = String(messagePulseAlpha(this.pulseTicks));
  }

  dispose(): void {
    this.img.remove();
  }
}

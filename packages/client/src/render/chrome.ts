/**
 * chrome.ts — screen chrome that boards are framed clear of.
 *
 * Fixed overlays (HUD, mode buttons, audio controls, touch controls) mark
 * themselves with {@link markChrome}; a screen's resize handler collects their
 * rectangles with {@link chromeRects} and hands them to `BoardView.resize`, which
 * slides/shrinks the board out from under any that would cover it. Marking
 * rather than passing elements around keeps screens from needing each other's
 * overlays (the audio controls, say, outlive every screen).
 */

import type { Rect } from '../view/cameraFit.js';
import type { BoardView } from './boardView.js';

/** Flag `el` as chrome that boards should avoid. Returns `el` for chaining. */
export function markChrome<T extends HTMLElement>(el: T): T {
  el.setAttribute('data-chrome', '');
  return el;
}

/**
 * Size each board's view to its container, framed clear of all visible chrome.
 * Boards shown together share one framing (chrome over either one moves both),
 * so side-by-side boards always match.
 */
export function fitBoards(
  boards: ReadonlyArray<{ container: HTMLElement; view: BoardView }>,
): void {
  const chrome = boards.flatMap((b) => chromeRects(b.container));
  for (const b of boards) {
    b.view.resize(b.container.clientWidth, b.container.clientHeight, chrome);
  }
}

/**
 * The rectangles of all visible chrome, relative to `viewport`'s top-left (so
 * they line up with a board canvas filling it). Hidden chrome has no box and is
 * skipped.
 */
export function chromeRects(viewport: HTMLElement): Rect[] {
  const origin = viewport.getBoundingClientRect();
  const rects: Rect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-chrome]')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    rects.push({
      left: r.left - origin.left,
      top: r.top - origin.top,
      right: r.right - origin.left,
      bottom: r.bottom - origin.top,
    });
  }
  return rects;
}

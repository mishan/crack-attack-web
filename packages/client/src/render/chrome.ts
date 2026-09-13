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

import { type Rect, frameBoards } from '../view/cameraFit.js';
import type { BoardView } from './boardView.js';

/** Flag `el` as chrome that boards should avoid. Returns `el` for chaining. */
export function markChrome<T extends HTMLElement>(el: T): T {
  el.setAttribute('data-chrome', '');
  return el;
}

/**
 * Size each board's view to its container, framed clear of all visible chrome.
 * Boards shown together share a size and height (chrome over either one moves
 * both), so side-by-side boards always match; each may slide sideways alone.
 */
export function fitBoards(
  boards: ReadonlyArray<{ container: HTMLElement; view: BoardView }>,
): void {
  if (boards.length === 0) return;
  const viewports = boards.map((b) => ({
    width: b.container.clientWidth,
    height: b.container.clientHeight,
    chrome: chromeRects(b.container),
  }));
  const frames = frameBoards(boards[0]!.view.fit, viewports);
  boards.forEach((b, i) => b.view.resize(viewports[i]!.width, viewports[i]!.height, frames[i]));
}

/** Pin a label's top-centre to its board's label anchor ({@link BoardView.labelAnchor}). */
export function placeLabel(label: HTMLElement, view: BoardView): void {
  const { x, y } = view.labelAnchor();
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
}

/**
 * Call `refit` whenever chrome marked so far changes size — shown, hidden, or
 * relabelled (a Save replay or Rematch button appearing, a status banner) — so
 * boards re-frame around it, not only on window resizes. The framing only moves
 * when that chrome would cover a board. Returns a function that stops watching.
 */
export function onChromeResize(refit: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(() => refit());
  for (const el of document.querySelectorAll('[data-chrome]')) observer.observe(el);
  return () => observer.disconnect();
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

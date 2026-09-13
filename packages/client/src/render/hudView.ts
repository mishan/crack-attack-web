/**
 * hudView.ts — the DOM heads-up display overlay, laid out like the original's
 * side column (DrawExternalCandy.cxx, DrawWinRecord.cxx).
 *
 * A thin platform layer (like {@link BoardView}, but DOM instead of WebGL): it
 * builds its elements once and, each frame, mirrors a {@link Hud} onto them.
 * Formatting lives in the pure `view/hud.ts` helpers, so this file only does DOM
 * plumbing.
 *
 * Top to bottom, centred as in the original column: the lose bar (solo only —
 * two-board screens keep one under each board), the win-record star, the solo
 * score and its record line, the play clock, and a status line (popping count,
 * the loss countdown when the stack is frozen at the top, and the game-over
 * prompt). Score and clock use the original clock digits, shaded blue to white.
 */

import { GC_STEPS_PER_SECOND } from '@crack-attack/core';
import type { Hud } from '../view/boardViewModel.js';
import { formatClock } from '../view/hud.js';
import { BitmapLabel } from './bitmapText.js';
import { CLOCK } from '../view/bitmapFont.js';
import { LoseBarCanvas } from './loseBarCanvas.js';

/** Column width, px; the lose bar spans it, as the original's spans its column. */
const COLUMN_WIDTH = 150;
const STAR_SIZE = 34;
/** The reference star turns 1° per tick (DC_STAR_PLAY_ANGULAR_VELOCITY): 7.2 s a turn. */
const STAR_TURN_MS = 360 * (1000 / GC_STEPS_PER_SECOND);
/** The star's colour while its game is unplayed (DC_STAR_UNPLAYED_*: 0.4, 0.4, 0.7). */
const STAR_COLOR = 'rgb(102, 102, 179)';

/** Up to this viewport width the column pairs items side by side, to stay short. */
const NARROW_MAX = 640;
const CSS = `
.hud-pair { display: flex; flex-direction: column; align-items: center; gap: 4px; }
@media (max-width: ${NARROW_MAX}px) { .hud-pair { flex-direction: row; gap: 10px; } }
`;

const el = (tag: string, style: Partial<CSSStyleDeclaration>): HTMLElement => {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  return node;
};

/** Numbers each star's gradient id, so no two stars on a page share one. */
let starCount = 0;

/** Points of a five-pointed star, point up, in a unit circle. */
function starPoints(): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.95 : 0.43;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(r * Math.cos(a)).toFixed(3)},${(r * Math.sin(a)).toFixed(3)}`);
  }
  return pts.join(' ');
}

/**
 * The win-record star (DrawWinRecord.cxx): the original solo screen's single
 * star, in its unplayed colour, turning at the reference's rate. Decorative for
 * now — there's no match record for it to show yet.
 */
function winRecordStar(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-1 -1 2 2');
  svg.setAttribute('width', String(STAR_SIZE));
  svg.setAttribute('height', String(STAR_SIZE));
  svg.setAttribute('aria-hidden', 'true');
  svg.style.overflow = 'visible';
  svg.style.filter = `drop-shadow(0 0 3px ${STAR_COLOR})`;

  // A bright core fading to the star colour, like the reference's mote texture.
  const fill = document.createElementNS(NS, 'radialGradient');
  fill.id = `hud-star-fill-${++starCount}`;
  for (const [offset, color] of [
    ['0', '#f4f4ff'],
    ['0.35', '#b8b8ec'],
    ['1', STAR_COLOR],
  ] as const) {
    const stop = document.createElementNS(NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    fill.append(stop);
  }
  const defs = document.createElementNS(NS, 'defs');
  defs.append(fill);
  const star = document.createElementNS(NS, 'polygon');
  star.setAttribute('points', starPoints());
  star.setAttribute('fill', `url(#${fill.id})`);
  svg.append(defs, star);

  const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (!still) {
    // Counter-clockwise, as the reference's positive glRotatef turns it on screen.
    svg.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-360deg)' }], {
      duration: STAR_TURN_MS,
      iterations: Infinity,
    });
  }
  return svg;
}

export interface HudViewOptions {
  /** Show the lose bar (solo; two-board screens draw one under each board). */
  loseBar?: boolean;
}

export class HudView {
  // Clock and score render with the original clock digits, shaded as drawDigit.
  private readonly clock = new BitmapLabel(CLOCK, { height: 20, shaded: true });
  private readonly score = new BitmapLabel(CLOCK, { height: 30, shaded: true });
  private readonly scoreWrap: HTMLElement;
  private readonly status: HTMLElement;
  private readonly record: HTMLElement;
  /** The HUD lose bar, when shown; tick it with the sim like {@link LoseBarView}. */
  readonly loseBar: LoseBarCanvas | null;

  constructor(container: HTMLElement, opts: HudViewOptions = {}) {
    const root = el('div', {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '4px',
      width: `${COLUMN_WIDTH}px`,
      textAlign: 'center',
      fontVariantNumeric: 'tabular-nums',
    });

    if (!document.getElementById('hud-style')) {
      const style = document.createElement('style');
      style.id = 'hud-style';
      style.textContent = CSS;
      document.head.append(style);
    }

    this.loseBar = opts.loseBar ? new LoseBarCanvas(COLUMN_WIDTH) : null;
    if (this.loseBar) root.append(this.loseBar.element);

    // Star over the solo score (hidden until updateScore is called), then its
    // record line (hidden until set) over the clock — each pair side by side on
    // a narrow screen — then the status line.
    this.scoreWrap = el('div', { display: 'none' });
    this.scoreWrap.append(this.score.element);
    const starPair = el('div', {});
    starPair.className = 'hud-pair';
    starPair.append(winRecordStar(), this.scoreWrap);
    this.record = el('div', { display: 'none', fontSize: '12px', opacity: '0.75' });
    const clockPair = el('div', {});
    clockPair.className = 'hud-pair';
    clockPair.append(this.record, this.clock.element);
    this.status = el('div', {
      fontSize: '13px',
      minHeight: '16px',
      opacity: '0.9',
      whiteSpace: 'nowrap',
    });
    root.append(starPair, clockPair, this.status);
    container.append(root);
  }

  /** Mirror `hud` onto the overlay. Call once per rendered frame. */
  update(hud: Hud): void {
    this.clock.setText(formatClock(hud.elapsedSeconds));

    if (hud.lost) {
      this.set('GAME OVER — press R', '#ff6b6b', true);
    } else if (hud.lossCountdown !== null) {
      // Sim ticks → seconds, rounded up so it reads like a countdown.
      const secs = Math.ceil(hud.lossCountdown / GC_STEPS_PER_SECOND);
      this.set(`DANGER — ${secs}s`, '#ff6b6b', true);
    } else if (hud.dyingCount > 0) {
      this.set(`POP ×${hud.dyingCount}`, '#ffd66b', false);
    } else {
      this.set('', '#d7dce5', false);
    }
  }

  /** Show the solo score (zero-padded string from ScoreState.formatted()). */
  updateScore(formatted: string): void {
    this.scoreWrap.style.display = 'block';
    this.score.setText(formatted);
  }

  /** Show a small record line under the score (best score, or a new-record note). */
  setScoreRecord(line: string): void {
    this.record.textContent = line;
    this.record.style.display = line ? 'block' : 'none';
  }

  private set(text: string, color: string, bold: boolean): void {
    this.status.textContent = text;
    this.status.style.color = color;
    this.status.style.fontWeight = bold ? '700' : '400';
  }
}

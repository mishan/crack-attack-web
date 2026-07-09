/**
 * hudView.ts — the DOM heads-up display overlay.
 *
 * A thin platform layer (like {@link BoardView}, but DOM instead of WebGL): it
 * builds its elements once and, each frame, mirrors a {@link Hud} onto them. All
 * presentation thresholds/formatting live in the pure `view/hud.ts` helpers, so
 * this file only does DOM plumbing.
 *
 * Shows: a play clock, a vertical "lose bar" that fills toward the safe-height
 * line and tints green→yellow→red, and a status line (popping count, the loss
 * countdown when the stack is frozen at the top, and the game-over prompt).
 */

import { GC_STEPS_PER_SECOND } from '@crack-attack/core';
import type { Hud } from '../view/boardViewModel.js';
import { type DangerTier, dangerTier, formatClock } from '../view/hud.js';

const TIER_COLOR: Record<DangerTier, string> = {
  safe: '#46b24a',
  warning: '#e0c53f',
  danger: '#e0483f',
};

const el = (tag: string, style: Partial<CSSStyleDeclaration>): HTMLElement => {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  return node;
};

export class HudView {
  private readonly clock: HTMLElement;
  private readonly barFill: HTMLElement;
  private readonly status: HTMLElement;

  constructor(container: HTMLElement) {
    const root = el('div', {
      display: 'flex',
      alignItems: 'flex-end',
      gap: '10px',
      fontVariantNumeric: 'tabular-nums',
    });

    const left = el('div', { display: 'flex', flexDirection: 'column', gap: '6px' });
    this.clock = el('div', { fontSize: '20px', fontWeight: '600', letterSpacing: '0.5px' });
    this.status = el('div', { fontSize: '13px', minHeight: '16px', opacity: '0.9' });
    left.append(this.clock, this.status);

    // Vertical lose bar: a track with a bottom-anchored fill that rises toward
    // the top (the safe-height line) as the stack climbs.
    const track = el('div', {
      position: 'relative',
      width: '12px',
      height: '132px',
      borderRadius: '6px',
      background: 'rgba(255,255,255,0.10)',
      overflow: 'hidden',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.15)',
    });
    this.barFill = el('div', {
      position: 'absolute',
      left: '0',
      right: '0',
      bottom: '0',
      height: '0%',
      background: TIER_COLOR.safe,
      transition: 'height 80ms linear, background 200ms linear',
    });
    track.append(this.barFill);

    root.append(left, track);
    container.append(root);
  }

  /** Mirror `hud` onto the overlay. Call once per rendered frame. */
  update(hud: Hud): void {
    this.clock.textContent = formatClock(hud.elapsedSeconds);

    const tier = dangerTier(hud.dangerFraction);
    this.barFill.style.height = `${Math.round(hud.dangerFraction * 100)}%`;
    this.barFill.style.background = TIER_COLOR[tier];

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

  private set(text: string, color: string, bold: boolean): void {
    this.status.textContent = text;
    this.status.style.color = color;
    this.status.style.fontWeight = bold ? '700' : '400';
  }
}

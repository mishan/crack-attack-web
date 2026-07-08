/**
 * hud.ts — pure presentation helpers for the HUD.
 *
 * Formatting and threshold logic only (no DOM), so it is unit-testable. The
 * {@link HudView} DOM layer consumes these to style the overlay.
 */

/** How close to losing: drives the danger-bar colour and urgency. */
export type DangerTier = 'safe' | 'warning' | 'danger';

/** Categorize the safe-height danger fraction (0..1) into a colour tier. */
export function dangerTier(fraction: number): DangerTier {
  if (fraction >= 0.8) return 'danger';
  if (fraction >= 0.5) return 'warning';
  return 'safe';
}

/** Format elapsed seconds as `m:ss` (minutes uncapped, seconds zero-padded). */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

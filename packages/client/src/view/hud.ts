/**
 * hud.ts — pure presentation helpers for the HUD.
 *
 * Formatting logic only (no DOM), so it is unit-testable. The {@link HudView}
 * DOM layer consumes these.
 */

/** Format elapsed seconds as `m:ss` (minutes uncapped, seconds zero-padded). */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

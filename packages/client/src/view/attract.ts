/**
 * attract.ts — pure rules for attract mode, the game's default landing screen.
 *
 * Like an arcade cabinet, a visitor first sees the title card, then the game
 * plays itself (hard-vs-hard AI matches) behind a PRESS ANY KEY prompt until
 * they press a key or click, which starts play. This module holds the timeline
 * constants and the "which keys count as start" rule, DOM-free so the rule is
 * unit-tested; `render/attractOverlay.ts` draws, `aiDemo.ts` and `main.ts` run it.
 */

import { GC_STEPS_PER_SECOND } from '@crack-attack/core';

/** Wall ticks the title card holds before each match's countdown starts. */
export const TITLE_HOLD_TICKS = 3 * GC_STEPS_PER_SECOND;

/** Wall ticks the title card takes to fade in or out (a match resets only once it's opaque). */
export const TITLE_FADE_TICKS = 30;

/**
 * Wall ticks from a match's result until the title card returns: the
 * celebration (225) plus a beat, so the winner's fireworks play out first.
 */
export const TITLE_RETURN_TICKS = 260;

/** The fields of a `KeyboardEvent` the start rule reads. */
export interface StartKey {
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  /** Whether focus is on an on-screen control (a button or link), e.g. the mute button. */
  readonly onControl?: boolean;
}

/** Keys that activate a focused button or link. */
const ACTIVATION_KEYS = new Set(['Space', 'Enter', 'NumpadEnter']);

/**
 * Keys that never start play: mute (M keeps its global meaning), focus
 * navigation (Tab, so keyboard users can reach the audio controls), and lone
 * modifiers / locks.
 */
const PASSIVE_KEYS = new Set([
  '',
  'Unidentified',
  'KeyM',
  'Tab',
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'ContextMenu',
]);

/**
 * Whether a key press should leave attract mode and start play. "Any key",
 * minus the ones a visitor presses without meaning to play: auto-repeat, the
 * {@link PASSIVE_KEYS}, function keys (refresh, fullscreen, devtools),
 * browser/OS shortcuts (anything chorded with Ctrl, Meta, or Alt), and Space /
 * Enter while an on-screen control has focus (they activate it instead).
 */
export function startsPlay(e: StartKey): boolean {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (/^F\d+$/.test(e.code)) return false;
  if (e.onControl && ACTIVATION_KEYS.has(e.code)) return false;
  return !PASSIVE_KEYS.has(e.code);
}

/**
 * messages.ts — pure logic for the big overlay messages (countdown, game
 * over, winner/loser, waiting).
 *
 * Faithful to `CountDownManager.{h,cxx}` and `MessageManager.h`: a new game
 * holds the *entire* gameplay step for GC_START_PAUSE_DELAY (150) ticks while
 * "3" → "2" → "1" swap every 50; "GO" then rides the first 50 ticks of actual
 * play (CountDownManager.cxx:60-88). Messages pulse their alpha with the
 * cos² wave baked in obj_messages.cxx:166-169.
 *
 * This is DOM-free decision logic; `render/messageOverlay.ts` draws it.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_START_PAUSE_DELAY } from '@crack-attack/core';

/** Ticks the gameplay step is held at game start (GC_START_PAUSE_DELAY). */
export const COUNTDOWN_GATE_TICKS = GC_START_PAUSE_DELAY;

/** How long "GO" stays up after play begins (GC_START_PAUSE_DELAY / 3). */
export const GO_DISPLAY_TICKS = GC_START_PAUSE_DELAY / 3;

/** One per overlay texture in public/textures/messages/. */
export type MessageKind =
  | 'count_down_3'
  | 'count_down_2'
  | 'count_down_1'
  | 'count_down_go'
  | 'message_game_over'
  | 'message_winner'
  | 'message_loser'
  | 'message_waiting'
  | 'message_paused';

/**
 * The countdown message for `metaTicks` ticks since game start (the first
 * COUNTDOWN_GATE_TICKS of which the sim is held). Returns null once GO has
 * expired. Mirrors the CountDownManager timeline: state swaps as
 * `message_switch_alarm` (50) runs out, twice inside the gate and once onto
 * GO at the gate boundary.
 */
export function countdownMessage(metaTicks: number): MessageKind | null {
  const phase = Math.floor(metaTicks / (GC_START_PAUSE_DELAY / 3));
  switch (phase) {
    case 0:
      return 'count_down_3';
    case 1:
      return 'count_down_2';
    case 2:
      return 'count_down_1';
    case 3:
      return 'count_down_go';
    default:
      return null;
  }
}

/**
 * Countdown beep volumes for the four phases (3, 2, 1, GO). The C++ plays
 * `GC_SOUND_COUNTDOWN` at `1 + state * 3` when `message_switch_alarm` hits 30
 * (CountDownManager.cxx:63-67), with `state` running 3 → 2 → 1 → 0. On the
 * C++ 0..10 volume scale.
 */
export const COUNTDOWN_BEEP_VOLUMES = [10, 7, 4, 1] as const;

/**
 * Offset, in ticks into a countdown phase, at which the beep fires. The C++
 * phase alarm starts at `GC_START_PAUSE_DELAY / 3` (50) and beeps when it
 * counts down to 30 — i.e. 20 ticks in.
 */
export const COUNTDOWN_BEEP_OFFSET = GC_START_PAUSE_DELAY / 3 - 30;

/**
 * How many countdown beeps should have sounded by `metaTicks` ticks since game
 * start (0..4). A stateful audio layer plays the delta since its last count, so
 * this works whether `metaTicks` advances one tick at a time (solo/netplay) or
 * jumps (the netplay display mirror). Beep `i` fires at
 * `i * (GC_START_PAUSE_DELAY / 3) + COUNTDOWN_BEEP_OFFSET`.
 */
export function countdownBeepsFired(metaTicks: number): number {
  const period = GC_START_PAUSE_DELAY / 3;
  let n = 0;
  for (let i = 0; i < COUNTDOWN_BEEP_VOLUMES.length; i++) {
    if (metaTicks >= i * period + COUNTDOWN_BEEP_OFFSET) n++;
  }
  return n;
}

/** Pulse period in ticks (DC_MESSAGE_PULSE_PERIOD, Displayer.h:351). */
export const MESSAGE_PULSE_PERIOD = 320;

/**
 * The message's alpha at pulse tick `t`: 0.75 + 0.6·cos²(2πt/period)
 * (obj_messages.cxx:166-169), clamped to 1 for CSS (GL saturates the same).
 */
export function messagePulseAlpha(t: number): number {
  const s = Math.cos((t % MESSAGE_PULSE_PERIOD) * ((2 * Math.PI) / MESSAGE_PULSE_PERIOD));
  return Math.min(1, 0.75 + 0.6 * s * s);
}

import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_BEEP_OFFSET,
  COUNTDOWN_BEEP_VOLUMES,
  COUNTDOWN_GATE_TICKS,
  GO_DISPLAY_TICKS,
  MESSAGE_PULSE_PERIOD,
  countdownBeepsFired,
  countdownMessage,
  messagePulseAlpha,
} from './messages.js';

describe('countdownMessage', () => {
  it('runs 3 → 2 → 1 across the 150-tick gate, swapping every 50', () => {
    expect(countdownMessage(0)).toBe('count_down_3');
    expect(countdownMessage(49)).toBe('count_down_3');
    expect(countdownMessage(50)).toBe('count_down_2');
    expect(countdownMessage(99)).toBe('count_down_2');
    expect(countdownMessage(100)).toBe('count_down_1');
    expect(countdownMessage(COUNTDOWN_GATE_TICKS - 1)).toBe('count_down_1');
  });

  it('GO rides the first 50 ticks of play, then clears', () => {
    expect(countdownMessage(COUNTDOWN_GATE_TICKS)).toBe('count_down_go');
    expect(countdownMessage(COUNTDOWN_GATE_TICKS + GO_DISPLAY_TICKS - 1)).toBe('count_down_go');
    expect(countdownMessage(COUNTDOWN_GATE_TICKS + GO_DISPLAY_TICKS)).toBeNull();
    expect(countdownMessage(100000)).toBeNull();
  });
});

describe('countdownBeepsFired', () => {
  const PERIOD = COUNTDOWN_GATE_TICKS / 3; // 50

  it('fires one beep per phase, 20 ticks in', () => {
    expect(COUNTDOWN_BEEP_OFFSET).toBe(20);
    expect(countdownBeepsFired(0)).toBe(0);
    expect(countdownBeepsFired(COUNTDOWN_BEEP_OFFSET - 1)).toBe(0);
    expect(countdownBeepsFired(COUNTDOWN_BEEP_OFFSET)).toBe(1); // "3"
    expect(countdownBeepsFired(PERIOD + COUNTDOWN_BEEP_OFFSET)).toBe(2); // "2"
    expect(countdownBeepsFired(2 * PERIOD + COUNTDOWN_BEEP_OFFSET)).toBe(3); // "1"
    expect(countdownBeepsFired(3 * PERIOD + COUNTDOWN_BEEP_OFFSET)).toBe(4); // "GO"
  });

  it('caps at four beeps and is monotonic (handles jumps)', () => {
    expect(countdownBeepsFired(100000)).toBe(COUNTDOWN_BEEP_VOLUMES.length);
    let prev = 0;
    for (let t = 0; t < 300; t++) {
      const n = countdownBeepsFired(t);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('volumes descend 10 → 1 across the phases', () => {
    expect([...COUNTDOWN_BEEP_VOLUMES]).toEqual([10, 7, 4, 1]);
  });
});

describe('messagePulseAlpha', () => {
  it('stays within [0.75, 1] (the GL clamp) and hits both ends', () => {
    let min = 2;
    let max = -1;
    for (let t = 0; t < MESSAGE_PULSE_PERIOD; t++) {
      const a = messagePulseAlpha(t);
      expect(a).toBeGreaterThanOrEqual(0.75);
      expect(a).toBeLessThanOrEqual(1);
      min = Math.min(min, a);
      max = Math.max(max, a);
    }
    expect(min).toBeCloseTo(0.75, 5);
    expect(max).toBe(1);
  });

  it('is periodic', () => {
    expect(messagePulseAlpha(7)).toBeCloseTo(messagePulseAlpha(7 + MESSAGE_PULSE_PERIOD), 10);
  });
});

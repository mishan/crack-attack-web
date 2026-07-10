import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_GATE_TICKS,
  GO_DISPLAY_TICKS,
  MESSAGE_PULSE_PERIOD,
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

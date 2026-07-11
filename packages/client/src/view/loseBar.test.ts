import { describe, expect, it } from 'vitest';
import { GC_LOSS_DELAY, GC_LOSS_DELAY_ELIMINATION } from '@crack-attack/core';
import {
  LB_FADE_HIGH_TO_INACTIVE,
  LB_FADE_LOW_TO_INACTIVE,
  LB_FADE_RESET_HIGH,
  LB_HIGH_ALERT,
  LB_INACTIVE,
  LB_LOW_ALERT,
  LOSEBAR_FADE_TIME,
  LoseBarState,
} from './loseBar.js';

const BLUE = [0, 0, 1];
const MAGENTA = [0.8, 0, 0.8];
const RED = [1, 0, 0];

describe('LoseBarState — inactive', () => {
  it('starts inactive and uniform blue (color1 === color2)', () => {
    const lb = new LoseBarState();
    expect(lb.state).toBe(LB_INACTIVE);
    expect([...lb.color1()]).toEqual(BLUE);
    expect([...lb.color2()]).toEqual(BLUE);
  });
});

describe('LoseBarState — low alert', () => {
  it('enters low alert on the first frozen tick, magenta over blue', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY);
    expect(lb.state).toBe(LB_LOW_ALERT);
    expect([...lb.color1()]).toEqual(MAGENTA);
    expect([...lb.color2()]).toEqual(BLUE);
    expect(lb.bar).toBe(0); // loss_alarm at max → empty
  });

  it('fills the bar 0→1 as loss_alarm counts 350→50', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY); // enter, bar 0
    lb.tick(true, 200);
    expect(lb.bar).toBeCloseTo((GC_LOSS_DELAY - 200) / (GC_LOSS_DELAY - GC_LOSS_DELAY_ELIMINATION));
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION + 1);
    expect(lb.bar).toBeGreaterThan(0.99);
  });
});

describe('LoseBarState — high alert', () => {
  it('enters high alert when loss_alarm reaches the elimination floor, red over magenta', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY);
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION); // low → high
    expect(lb.state).toBe(LB_HIGH_ALERT);
    expect([...lb.color1()]).toEqual(RED);
    expect([...lb.color2()]).toEqual(MAGENTA);
    expect(lb.bar).toBe(0); // two-phase: bar resets at the low→high boundary
  });

  it('refills the bar 0→1 as loss_alarm counts 50→0', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY);
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION);
    lb.tick(true, 25);
    expect(lb.bar).toBeCloseTo((GC_LOSS_DELAY_ELIMINATION - 25) / GC_LOSS_DELAY_ELIMINATION);
    lb.tick(true, 0);
    expect(lb.bar).toBe(1);
  });
});

describe('LoseBarState — fades', () => {
  it('low alert → fade → inactive over the fade time when the freeze ends', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY); // low alert
    lb.tick(false, GC_LOSS_DELAY); // freeze ends → fade (entered without decrement)
    expect(lb.state).toBe(LB_FADE_LOW_TO_INACTIVE);
    for (let i = 0; i < LOSEBAR_FADE_TIME - 1; i++) lb.tick(false, 0);
    expect(lb.state).toBe(LB_FADE_LOW_TO_INACTIVE); // one tick still to go
    lb.tick(false, 0);
    expect(lb.state).toBe(LB_INACTIVE);
  });

  it('high alert → fade → inactive when the freeze ends', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY);
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION); // high alert
    lb.tick(false, 0); // freeze ends → fade (entered without decrement)
    expect(lb.state).toBe(LB_FADE_HIGH_TO_INACTIVE);
    for (let i = 0; i < LOSEBAR_FADE_TIME; i++) lb.tick(false, 0);
    expect(lb.state).toBe(LB_INACTIVE);
  });

  it('a high-alert reset (loss_alarm bumped back up by a pop) re-flashes, then returns to high', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY);
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION); // high alert
    lb.tick(true, 20); // counting down in high alert
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION); // pop resets loss_alarm up → reset fade
    expect(lb.state).toBe(LB_FADE_RESET_HIGH);
    for (let i = 0; i < LOSEBAR_FADE_TIME - 1; i++) lb.tick(true, GC_LOSS_DELAY_ELIMINATION);
    expect(lb.state).toBe(LB_HIGH_ALERT);
  });

  it('keeps the fill tracking loss_alarm during the reset flash (not frozen)', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY);
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION);
    lb.tick(true, 20); // high alert, bar = (50-20)/50 = 0.6
    expect(lb.bar).toBeCloseTo(0.6);
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION); // reset flash: loss_alarm back to 50
    expect(lb.state).toBe(LB_FADE_RESET_HIGH);
    // bar reflects the live loss_alarm (empty), not the frozen 0.6
    expect(lb.bar).toBe(0);
  });
});

describe('LoseBarState — gameStart', () => {
  it('resets to inactive', () => {
    const lb = new LoseBarState();
    lb.tick(true, GC_LOSS_DELAY);
    lb.tick(true, GC_LOSS_DELAY_ELIMINATION);
    lb.gameStart();
    expect(lb.state).toBe(LB_INACTIVE);
    expect(lb.bar).toBe(0);
    expect([...lb.color1()]).toEqual(BLUE);
  });
});

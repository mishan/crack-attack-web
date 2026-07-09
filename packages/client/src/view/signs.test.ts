import { describe, expect, it } from 'vitest';
import {
  SIGN_FINAL_INFLATE_SIZE,
  SIGN_HOLD_TIME,
  SIGN_LIFE_TIME,
  SIGN_TERMINAL_VELOCITY,
  signAlpha,
  signColor,
  signExpired,
  signRiseDelta,
  signScale,
  signTextureKey,
} from './signs.js';

describe('signTextureKey', () => {
  it('maps magnitude level to the combo-size badge (level + 4)', () => {
    expect(signTextureKey('magnitude', 0)).toBe('sign_4');
    expect(signTextureKey('magnitude', 3)).toBe('sign_7');
    expect(signTextureKey('magnitude', 8)).toBe('sign_12');
  });

  it('maps multiplier level to the ×(level + 2) badge', () => {
    expect(signTextureKey('multiplier', 0)).toBe('sign_x2');
    expect(signTextureKey('multiplier', 10)).toBe('sign_x12');
  });

  it('shows the single bonus badge for any special', () => {
    expect(signTextureKey('special', 0)).toBe('sign_bonus');
    expect(signTextureKey('special', 5)).toBe('sign_bonus');
  });

  it('clamps levels beyond the available art (as SignManager does)', () => {
    expect(signTextureKey('magnitude', 99)).toBe('sign_12');
    expect(signTextureKey('multiplier', 99)).toBe('sign_x12');
  });

  it('clamps negative levels to the lowest badge', () => {
    expect(signTextureKey('magnitude', -3)).toBe('sign_4');
  });
});

describe('sign colour', () => {
  it('tints each kind distinctly', () => {
    expect(signColor('magnitude')).toBe(0xffffff);
    expect(signColor('multiplier')).toBe(0xffe24a);
    expect(signColor('special')).toBe(0xff8a3d);
  });
});

describe('sign lifetime', () => {
  it('holds full opacity and unit scale during the hold', () => {
    expect(signAlpha(0)).toBe(1);
    expect(signAlpha(SIGN_HOLD_TIME - 1)).toBe(1);
    expect(signScale(0)).toBe(1);
  });

  it('fades to zero and inflates toward the peak across the fade', () => {
    // Start of fade: still ~full alpha, ~unit scale.
    expect(signAlpha(SIGN_HOLD_TIME)).toBeCloseTo(1, 5);
    expect(signScale(SIGN_HOLD_TIME)).toBeCloseTo(1, 5);
    // End of life: fully transparent, fully inflated.
    expect(signAlpha(SIGN_LIFE_TIME)).toBeCloseTo(0, 5);
    expect(signScale(SIGN_LIFE_TIME)).toBeCloseTo(SIGN_FINAL_INFLATE_SIZE, 5);
    // Monotonic within the fade.
    expect(signAlpha(200)).toBeGreaterThan(signAlpha(260));
    expect(signScale(260)).toBeGreaterThan(signScale(200));
  });

  it('ramps the float speed to terminal over the hold, then holds it', () => {
    expect(signRiseDelta(0)).toBe(0);
    expect(signRiseDelta(SIGN_HOLD_TIME)).toBeCloseTo(SIGN_TERMINAL_VELOCITY, 10);
    expect(signRiseDelta(SIGN_LIFE_TIME - 1)).toBe(SIGN_TERMINAL_VELOCITY);
  });

  it('expires at the end of its life', () => {
    expect(signExpired(SIGN_LIFE_TIME - 1)).toBe(false);
    expect(signExpired(SIGN_LIFE_TIME)).toBe(true);
  });

  it('clamps an over-age life (large dt) to fully faded / fully inflated', () => {
    // Past end-of-life the raw fade goes negative; squaring it must not revive
    // opacity or grow the sign past its final size.
    expect(signAlpha(SIGN_LIFE_TIME + 50)).toBe(0);
    expect(signScale(SIGN_LIFE_TIME + 50)).toBe(SIGN_FINAL_INFLATE_SIZE);
  });
});

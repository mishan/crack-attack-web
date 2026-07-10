import { describe, expect, it } from 'vitest';
import { MUSIC_BASE_GAIN, SOUND_VOLUME_MAX, clamp, musicGain, sfxGain } from './volume.js';

describe('sfxGain', () => {
  it('maps the C++ 0..10 scale linearly to 0..1', () => {
    expect(sfxGain(0, 1, false)).toBe(0);
    expect(sfxGain(5, 1, false)).toBeCloseTo(0.5);
    expect(sfxGain(SOUND_VOLUME_MAX, 1, false)).toBe(1);
  });

  it('clamps event volume above 10 (Sound.cxx caps it)', () => {
    expect(sfxGain(36, 1, false)).toBe(1); // e.g. a 6x6 garbage slab area
  });

  it('scales by the user SFX volume and zeroes when muted', () => {
    expect(sfxGain(10, 0.5, false)).toBeCloseTo(0.5);
    expect(sfxGain(10, 1, true)).toBe(0);
  });
});

describe('musicGain', () => {
  it('defaults to the faithful quarter volume', () => {
    expect(musicGain(1, false)).toBeCloseTo(MUSIC_BASE_GAIN);
  });

  it('scales by the user music volume and zeroes when muted', () => {
    expect(musicGain(0.5, false)).toBeCloseTo(MUSIC_BASE_GAIN * 0.5);
    expect(musicGain(1, true)).toBe(0);
  });
});

describe('clamp', () => {
  it('bounds to the range', () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
  });
});

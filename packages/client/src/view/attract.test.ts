import { describe, expect, it } from 'vitest';
import { startsPlay, type StartKey } from './attract.js';

const key = (code: string, extra: Partial<StartKey> = {}): StartKey => ({
  code,
  repeat: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

describe('startsPlay', () => {
  it('starts on ordinary keys, game controls included', () => {
    for (const code of ['Space', 'Enter', 'KeyZ', 'KeyX', 'ArrowLeft', 'Escape', 'Digit1']) {
      expect(startsPlay(key(code))).toBe(true);
    }
  });

  it('ignores mute, focus navigation, and lone modifiers', () => {
    for (const code of ['KeyM', 'Tab', 'ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft']) {
      expect(startsPlay(key(code))).toBe(false);
    }
  });

  it('ignores function keys and unidentified keys', () => {
    for (const code of ['F5', 'F11', 'F12', '', 'Unidentified']) {
      expect(startsPlay(key(code))).toBe(false);
    }
  });

  it('leaves Space and Enter to a focused control, but other keys still start', () => {
    expect(startsPlay(key('Space', { onControl: true }))).toBe(false);
    expect(startsPlay(key('Enter', { onControl: true }))).toBe(false);
    expect(startsPlay(key('NumpadEnter', { onControl: true }))).toBe(false);
    expect(startsPlay(key('KeyZ', { onControl: true }))).toBe(true);
    expect(startsPlay(key('Space', { onControl: false }))).toBe(true);
  });

  it('ignores browser shortcuts and auto-repeat', () => {
    expect(startsPlay(key('KeyR', { ctrlKey: true }))).toBe(false);
    expect(startsPlay(key('KeyL', { metaKey: true }))).toBe(false);
    expect(startsPlay(key('ArrowLeft', { altKey: true }))).toBe(false);
    expect(startsPlay(key('Space', { repeat: true }))).toBe(false);
  });
});

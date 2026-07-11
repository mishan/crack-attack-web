import { describe, expect, it } from 'vitest';
import { CLOCK, FONT0, layout } from './bitmapFont.js';

describe('font metrics', () => {
  it('font0 maps 86 glyphs with digits first, then A-Z, a-z, punctuation', () => {
    expect(FONT0.glyphs.size).toBe(86);
    expect(FONT0.glyphs.get('0')!.index).toBe(0);
    expect(FONT0.glyphs.get('A')!.index).toBe(10);
    expect(FONT0.glyphs.get('a')!.index).toBe(36);
    expect(FONT0.glyphs.get('-')!.index).toBe(62); // first punctuation
    expect(FONT0.glyphs.get(']')!.index).toBe(85); // last punctuation
  });

  it('font0 widths match the reference letter_widths', () => {
    expect(FONT0.glyphs.get('0')!.width).toBe(20);
    expect(FONT0.glyphs.get('W')!.width).toBe(30);
    expect(FONT0.glyphs.get('i')!.width).toBe(8);
  });

  it('every font0 glyph has a defined positive width (chars/widths in sync)', () => {
    for (const [ch, g] of FONT0.glyphs) {
      expect(Number.isInteger(g.width), `width for ${ch}`).toBe(true);
      expect(g.width).toBeGreaterThan(0);
    }
  });

  it('clock maps digits to cells 0-9 and the colon to the extra cell (10)', () => {
    expect(CLOCK.glyphs.get('7')!.index).toBe(7);
    expect(CLOCK.glyphs.get(':')!.index).toBe(10);
    expect(CLOCK.glyphs.has('a')).toBe(false); // clock is digits + colon only
  });
});

describe('layout', () => {
  it('advances the pen by each glyph width and reports total width', () => {
    const l = layout('12', FONT0);
    expect(l.glyphs).toEqual([
      { index: 1, x: 0 },
      { index: 2, x: 12 }, // after '1' (width 12)
    ]);
    expect(l.width).toBe(12 + 17); // widths of '1' and '2'
  });

  it('lays out a clock string with the colon glyph', () => {
    const l = layout('1:23', CLOCK);
    expect(l.glyphs.map((g) => g.index)).toEqual([1, 10, 2, 3]);
    // 24 (1) + 14 (colon) + 24 (2) + 24 (3)
    expect(l.width).toBe(24 + 14 + 24 + 24);
  });

  it('advances a space by the font space width and skips unmapped chars', () => {
    const l = layout('A B', FONT0); // space between, then 'B'
    // 'A' at 0 (w 28), space (+10), 'B' at 38
    expect(l.glyphs).toEqual([
      { index: 10, x: 0 },
      { index: 11, x: 28 + 10 },
    ]);
    const withUnknown = layout('A☃B', FONT0); // snowman not in the font
    expect(withUnknown.glyphs.map((g) => g.index)).toEqual([10, 11]);
  });
});

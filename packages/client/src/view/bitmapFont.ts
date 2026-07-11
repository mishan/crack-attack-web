/**
 * bitmapFont.ts — pure metrics + layout for the original bitmap glyph fonts.
 *
 * The reference draws names, the clock, and scores with small glyph textures
 * (`font0_*.tga`, `clock_*.tga`) composited into string textures by
 * `String::fillStringTexture` (String.cxx). This module ports the two things
 * that layout needs and nothing DOM: the char→glyph map, the per-glyph advance
 * widths, and a `layout()` that turns a string into glyph placements.
 *
 * Faithful details: each glyph is a 32×32 cell; the pen advances by the glyph's
 * `letter_widths` value (glyphs are left-aligned in their cell, so consecutive
 * cells overlap into the transparent right padding — exactly the C++ cursor
 * logic); a space advances `DC_SPACE_WIDTH = 10`; an unmapped char is skipped
 * (`mapCharToCode == -1`). The `render/bitmapText.ts` layer paints the glyphs
 * from the converted atlases (`public/textures/font/{font0,clock}.png`).
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

/** Every glyph cell is 32×32 (DC_LETTER_TEX_LENGTH). */
export const GLYPH_CELL = 32;

/** A glyph's atlas cell index and its pen advance (px within the 32-cell). */
export interface Glyph {
  readonly index: number;
  readonly width: number;
}

export interface Font {
  /** Atlas basename under public/textures/font/ (`font0` | `clock`). */
  readonly atlas: string;
  readonly cell: number;
  /** Advance for a space (DC_SPACE_WIDTH). */
  readonly space: number;
  readonly glyphs: ReadonlyMap<string, Glyph>;
}

// --- font0: names / general text (String.cxx letter_mapping + letter_widths) ---

// The 86 glyphs in atlas order (= letter_texture_files order): digits, A–Z,
// a–z, then punctuation. Must stay in sync with the atlas build.
const FONT0_CHARS =
  '0123456789' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz' +
  '-:.,!@~#$%&()/<>?=+|;[*]';

// letter_widths[0] from String.cxx, in the same order as FONT0_CHARS.
// prettier-ignore
const FONT0_WIDTHS = [
  20, 12, 17, 14, 16, 15, 16, 19, 17, 16, // 0-9
  28, 20, 17, 20, 18, 20, 20, 19, 11, 17, 19, 17, 30, 20, 20, 21, 22, 22, 16, 21, 20, 20, 30, 25, 22, 19, // A-Z
  19, 14, 13, 14, 13, 14, 15, 14, 8, 12, 14, 12, 22, 15, 14, 14, 16, 16, 12, 15, 14, 15, 22, 18, 17, 13, // a-z
  20, 12, 11, 10, 11, 21, 23, 23, 18, 19, 20, 12, 13, 18, 16, 16, 17, 20, 23, 16, 22, 22, 16, 22, // punctuation
];

function buildFont0(): Font {
  // The char list, the width list, and the atlas cells must stay 1:1. Fail fast
  // (at module load, so a test catches it) rather than produce undefined widths.
  if (FONT0_CHARS.length !== FONT0_WIDTHS.length) {
    throw new Error(
      `font0 metrics out of sync: ${FONT0_CHARS.length} chars vs ${FONT0_WIDTHS.length} widths`,
    );
  }
  const glyphs = new Map<string, Glyph>();
  for (let i = 0; i < FONT0_CHARS.length; i++) {
    glyphs.set(FONT0_CHARS[i]!, { index: i, width: FONT0_WIDTHS[i]! });
  }
  return { atlas: 'font0', cell: GLYPH_CELL, space: 10, glyphs };
}

/** The names/text font. */
export const FONT0 = buildFont0();

// --- clock: the digit set used for the clock and the score readout ---
// Atlas cells 0–9 are the digits, cell 10 is `clock_extra` (the ':' separator).
// The digit ink is centred in each cell, so a fixed pitch reads as monospace.

function buildClock(): Font {
  const glyphs = new Map<string, Glyph>();
  for (let d = 0; d < 10; d++) glyphs.set(String(d), { index: d, width: 24 });
  glyphs.set(':', { index: 10, width: 14 });
  return { atlas: 'clock', cell: GLYPH_CELL, space: 12, glyphs };
}

/** The clock/score digit font. */
export const CLOCK = buildClock();

/** One placed glyph: which atlas cell, and the pen x (in glyph px) to draw its cell at. */
export interface Placement {
  readonly index: number;
  readonly x: number;
}

export interface Layout {
  readonly glyphs: Placement[];
  /** Total advance width, in glyph px. */
  readonly width: number;
}

/**
 * Lay a string out into glyph placements. Ports the `String::fillStringTexture`
 * cursor loop: advance by each glyph's width, add {@link Font.space} for a
 * space, skip unmapped chars. (The C++ `~` colour/font escapes are not needed
 * for our numeric clock/score and plain names, so `~` maps to its literal glyph.)
 */
export function layout(text: string, font: Font): Layout {
  const glyphs: Placement[] = [];
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') {
      x += font.space;
      continue;
    }
    const g = font.glyphs.get(ch);
    if (!g) continue; // unmapped char — skipped, as mapCharToCode == -1 does
    glyphs.push({ index: g.index, x });
    x += g.width;
  }
  return { glyphs, width: x };
}

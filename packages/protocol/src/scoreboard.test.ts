import { describe, expect, it, vi } from 'vitest';
import { ProtocolError } from './codec.js';
import {
  SCORE_NAME_MAX_INPUT,
  decodeSoloSubmitRequest,
  isRunId,
  monthKey,
  monthRange,
  normalizeScoreName,
} from './scoreboard.js';

describe('normalizeScoreName', () => {
  it.each([
    ['  Misha  ', 'Misha'],
    ['a \t\n  b', 'a b'],
    ['Mi\u200bsha', 'Misha'], // zero-width space (format)
    ['\u202eevil', 'evil'], // right-to-left override (format)
    ['\u0007bell', 'bell'], // control
    ['\ue000x', 'x'], // private use
    ['e\u0301', 'é'], // composed (NFC)
    ['x\u0301\u0302\u0303\u0304', 'x\u0301\u0302'], // stacked marks capped at two
    ['a'.repeat(20), 'a'.repeat(16)],
    ['\u{1f600}'.repeat(20), '\u{1f600}'.repeat(16)], // an emoji is one character
  ])('cleans %j to %j', (raw, name) => {
    expect(normalizeScoreName(raw)).toBe(name);
  });

  it.each([[''], ['   '], ['\u200b\u200b'], ['a'.repeat(SCORE_NAME_MAX_INPUT + 1)]])(
    'rejects %j',
    (raw) => {
      expect(normalizeScoreName(raw)).toBeNull();
    },
  );
});

describe('normalizeScoreName: invisible characters and graphemes', () => {
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';
  const flags = '\u{1F1FA}\u{1F1F8}'.repeat(16);

  it.each([
    ['a zero-width space between spaces', 'a \u200B b', 'a b'], // no double space
    ['mixed whitespace', 'a\t\u00A0b', 'a b'],
    ['a byte-order mark', '\uFEFFmisha', 'misha'],
    ['an emoji ZWJ sequence', family, family],
    ['Persian with a ZWNJ', persian, persian],
    ['joiners at the edges', '\u200Dab\u200C', 'ab'],
    ['a joiner beside spaces', 'a \u200D b', 'a b'],
    ['a run of joiners', 'a\u200C\u200Db', 'ab'],
    ['a Hangul filler', 'a\u3164b', 'a b'],
    ['braille blanks', 'a\u2800\u2800b', 'a b'],
    ['a combining grapheme joiner', 'x\u034Fy', 'xy'],
    ['17 letters', 'a'.repeat(17), 'a'.repeat(16)],
    ['20 accented letters', 'x\u0301'.repeat(20), 'x\u0301'.repeat(16)],
    ['16 flags (32 code points)', flags, flags],
  ])('cleans up %s', (_label, raw, name) => {
    expect(normalizeScoreName(raw)).toBe(name);
  });

  it.each([
    ['a Hangul filler', '\u3164'],
    ['Hangul jamo fillers', '\u115F\u1160'],
    ['a halfwidth filler and a braille blank', '\uFFA0 \u2800'],
    ['a Mongolian vowel separator', '\u180E'],
    ['a lone joiner', '\u200D'],
    ['a non-joiner between spaces', ' \u200C '],
    ['a combining grapheme joiner', '\u034F'],
  ])('finds nothing usable in %s', (_label, raw) => {
    expect(normalizeScoreName(raw)).toBeNull();
  });

  it('counts code points where Intl.Segmenter is missing', async () => {
    vi.resetModules();
    vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: undefined } }) as typeof Intl);
    try {
      const { normalizeScoreName: withoutSegmenter } = await import('./scoreboard.js');
      expect(withoutSegmenter('x\u0301'.repeat(20))).toBe('x\u0301'.repeat(8));
      expect(withoutSegmenter('\u{1F600}'.repeat(20))).toBe('\u{1F600}'.repeat(16));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('isRunId', () => {
  it('accepts 32 lowercase hex digits only', () => {
    expect(isRunId('0123456789abcdef'.repeat(2))).toBe(true);
    expect(isRunId('0123456789ABCDEF'.repeat(2))).toBe(false);
    expect(isRunId('a'.repeat(31))).toBe(false);
    expect(isRunId('g'.repeat(32))).toBe(false);
  });
});

describe('decodeSoloSubmitRequest', () => {
  const runId = 'a'.repeat(32);

  it('keeps the envelope and passes the replay through untouched', () => {
    const replay = { anything: true };
    expect(decodeSoloSubmitRequest({ runId, name: 'x', replay, extra: 1 })).toEqual({
      runId,
      name: 'x',
      replay,
    });
  });

  it.each([
    ['a non-object', 'nope'],
    ['an array', [runId, 'x', {}]],
    ['a bad run id', { runId: 'nope', name: 'x', replay: {} }],
    ['a missing name', { runId, replay: {} }],
    ['a missing replay', { runId, name: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(() => decodeSoloSubmitRequest(value)).toThrow(ProtocolError);
  });
});

describe('months', () => {
  it('keys a time by its UTC calendar month', () => {
    expect(monthKey(Date.UTC(2026, 8, 30, 23, 59))).toBe('2026-09');
    expect(monthKey(Date.UTC(2026, 9, 1))).toBe('2026-10');
  });

  it('maps a month to its half-open range, across a year end', () => {
    expect(monthRange('2026-12')).toEqual({
      from: Date.UTC(2026, 11, 1),
      to: Date.UTC(2027, 0, 1),
    });
  });

  it.each([['2026-13'], ['2026-00'], ['1999-05'], ['2026-9'], ['2026-09-01'], ['']])(
    'rejects %j',
    (key) => {
      expect(monthRange(key)).toBeNull();
    },
  );
});

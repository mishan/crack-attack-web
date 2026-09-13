import { describe, expect, it } from 'vitest';
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
    ['Mi​sha', 'Misha'], // zero-width space (format)
    ['‮evil', 'evil'], // right-to-left override (format)
    ['bell', 'bell'], // control
    ['x', 'x'], // private use
    ['é', 'é'], // composed (NFC)
    ['x́̂̃̄', 'x́̂'], // stacked marks capped at two
    ['a'.repeat(20), 'a'.repeat(16)],
    ['\u{1f600}'.repeat(20), '\u{1f600}'.repeat(16)], // counted in code points
  ])('cleans %j to %j', (raw, name) => {
    expect(normalizeScoreName(raw)).toBe(name);
  });

  it.each([[''], ['   '], ['​​'], ['a'.repeat(SCORE_NAME_MAX_INPUT + 1)]])('rejects %j', (raw) => {
    expect(normalizeScoreName(raw)).toBeNull();
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

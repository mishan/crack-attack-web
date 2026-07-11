import { describe, expect, it } from 'vitest';
import { GC_SCORE_MULT_LENGTH, GC_SCORE_REC_LENGTH } from '@crack-attack/core';
import {
  defaultMultRecords,
  defaultScoreRecords,
  humanRank,
  insertMult,
  insertScore,
} from './scoreRecords.js';

describe('default records', () => {
  it('score table is ascending, full length, top 600 / bottom 20', () => {
    const r = defaultScoreRecords();
    expect(r).toHaveLength(GC_SCORE_REC_LENGTH);
    expect(r[0]!.score).toBe(20);
    expect(r[GC_SCORE_REC_LENGTH - 1]!.score).toBe(600);
    for (let n = 1; n < r.length; n++) expect(r[n]!.score).toBeGreaterThanOrEqual(r[n - 1]!.score);
  });

  it('multiplier table is ascending and full length', () => {
    const r = defaultMultRecords();
    expect(r).toHaveLength(GC_SCORE_MULT_LENGTH);
    for (let n = 1; n < r.length; n++)
      expect(r[n]!.multiplier).toBeGreaterThan(r[n - 1]!.multiplier);
  });
});

describe('insertScore', () => {
  it('places a top score at the best index and keeps length', () => {
    const { records, rank } = insertScore(defaultScoreRecords(), 'ace', 10_000);
    expect(rank).toBe(GC_SCORE_REC_LENGTH - 1); // best slot
    expect(records).toHaveLength(GC_SCORE_REC_LENGTH);
    expect(records[rank]!).toEqual({ name: 'ace', score: 10_000 });
    // still ascending, weakest dropped (bottom rose from 20 to 40)
    expect(records[0]!.score).toBe(40);
  });

  it('places a mid score at the right rank', () => {
    // default scores are 20,40,...,600; 250 beats slots with score < 250
    const { rank } = insertScore(defaultScoreRecords(), 'mid', 250);
    // 250 > 240 (index 11) but < 260 (index 12): highest beatable index is 11
    expect(rank).toBe(11);
  });

  it('rejects a score below the whole table', () => {
    const { rank } = insertScore(defaultScoreRecords(), 'low', 5);
    expect(rank).toBe(-1);
  });

  it('does not mutate the input array', () => {
    const input = defaultScoreRecords();
    const snapshot = input.map((r) => ({ ...r }));
    insertScore(input, 'x', 9999);
    expect(input).toEqual(snapshot);
  });
});

describe('insertMult', () => {
  it('places a big multiplier at the top', () => {
    const { records, rank } = insertMult(defaultMultRecords(), 'combo', 20);
    expect(rank).toBe(GC_SCORE_MULT_LENGTH - 1);
    expect(records[rank]!).toEqual({ name: 'combo', multiplier: 20 });
  });

  it('rejects a multiplier at or below the floor', () => {
    expect(insertMult(defaultMultRecords(), 'x', 2).rank).toBe(-1); // floor is 2
  });
});

describe('humanRank', () => {
  it('maps the best ascending index to rank 1, unplaced to 0', () => {
    expect(humanRank(GC_SCORE_REC_LENGTH - 1, GC_SCORE_REC_LENGTH)).toBe(1);
    expect(humanRank(GC_SCORE_REC_LENGTH - 2, GC_SCORE_REC_LENGTH)).toBe(2);
    expect(humanRank(-1, GC_SCORE_REC_LENGTH)).toBe(0);
  });
});

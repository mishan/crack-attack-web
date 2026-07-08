import { describe, expect, it } from 'vitest';
import {
  BF_BLACK,
  BF_GRAY,
  BF_NORMAL_1,
  BF_NORMAL_5,
  BF_SPECIAL_COLOR_1,
  BF_SPECIAL_COLOR_3,
  BF_WHITE,
  BF_WILD,
} from './constants.js';
import {
  GF_GRAY,
  GF_NORMAL,
  flavorMatch,
  garbageIsSpecialFlavor,
  isBaseFlavor,
  isColorlessCode,
  isColorlessFlavor,
  isNormalFlavor,
  isSpecialColorFlavor,
  isSpecialFlavor,
  mapBlockCodeToGarbageFlavor,
  mapFlavorToBaseFlavor,
  mapSpecialColorFlavorToColor,
  mapSpecialFlavorToCode,
} from './flavors.js';

describe('flavor classification', () => {
  it('isNormalFlavor includes normals and wild, excludes gray', () => {
    expect(isNormalFlavor(BF_NORMAL_1)).toBe(true);
    expect(isNormalFlavor(BF_NORMAL_5)).toBe(true);
    expect(isNormalFlavor(BF_WILD)).toBe(true); // BF_NUMBER_NORMAL === BF_WILD
    expect(isNormalFlavor(BF_GRAY)).toBe(false);
  });

  it('isBaseFlavor is everything up to gray', () => {
    expect(isBaseFlavor(BF_NORMAL_1)).toBe(true);
    expect(isBaseFlavor(BF_GRAY)).toBe(true);
    expect(isBaseFlavor(BF_BLACK)).toBe(false);
  });

  it('isColorlessFlavor spans gray..white', () => {
    expect(isColorlessFlavor(BF_GRAY)).toBe(true);
    expect(isColorlessFlavor(BF_BLACK)).toBe(true);
    expect(isColorlessFlavor(BF_WHITE)).toBe(true);
    expect(isColorlessFlavor(BF_NORMAL_1)).toBe(false);
    expect(isColorlessFlavor(BF_SPECIAL_COLOR_1)).toBe(false);
  });

  it('isSpecialFlavor / isSpecialColorFlavor boundaries', () => {
    expect(isSpecialFlavor(BF_GRAY)).toBe(false);
    expect(isSpecialFlavor(BF_BLACK)).toBe(true);
    expect(isSpecialColorFlavor(BF_WHITE)).toBe(false);
    expect(isSpecialColorFlavor(BF_SPECIAL_COLOR_1)).toBe(true);
  });
});

describe('flavor mapping', () => {
  it('base flavors map to themselves', () => {
    expect(mapFlavorToBaseFlavor(BF_NORMAL_1)).toBe(BF_NORMAL_1);
    expect(mapFlavorToBaseFlavor(BF_GRAY)).toBe(BF_GRAY);
  });

  it('special colors map onto their corresponding normal color', () => {
    expect(mapSpecialColorFlavorToColor(BF_SPECIAL_COLOR_1)).toBe(BF_NORMAL_1);
    expect(mapFlavorToBaseFlavor(BF_SPECIAL_COLOR_1)).toBe(BF_NORMAL_1);
    expect(mapFlavorToBaseFlavor(BF_SPECIAL_COLOR_3)).toBe(BF_NORMAL_1 + 2);
  });

  it('colorless-but-not-special-color flavors map to gray', () => {
    expect(mapFlavorToBaseFlavor(BF_BLACK)).toBe(BF_GRAY);
    expect(mapFlavorToBaseFlavor(BF_WHITE)).toBe(BF_GRAY);
  });

  it('special-flavor codes', () => {
    expect(mapSpecialFlavorToCode(BF_BLACK)).toBe(0); // BF_BLACK - (BF_GRAY + 1)
    expect(mapSpecialFlavorToCode(BF_WHITE)).toBe(1);
    expect(isColorlessCode(0)).toBe(true);
    expect(isColorlessCode(1)).toBe(true);
    expect(isColorlessCode(2)).toBe(false);
  });
});

describe('flavorMatch (non-X path)', () => {
  it('same normal color matches', () => {
    expect(flavorMatch(BF_NORMAL_1, BF_NORMAL_1)).toBe(true);
  });

  it('different normal colors do not match', () => {
    expect(flavorMatch(BF_NORMAL_1, BF_NORMAL_5)).toBe(false);
  });

  it('a special color matches the normal color it maps to', () => {
    expect(flavorMatch(BF_SPECIAL_COLOR_1, BF_NORMAL_1)).toBe(true);
  });

  it('black and white both collapse to gray and match each other', () => {
    expect(flavorMatch(BF_BLACK, BF_WHITE)).toBe(true);
    expect(flavorMatch(BF_BLACK, BF_GRAY)).toBe(true);
  });
});

describe('garbage flavor helpers', () => {
  it('garbageIsSpecialFlavor', () => {
    expect(garbageIsSpecialFlavor(GF_NORMAL)).toBe(false);
    expect(garbageIsSpecialFlavor(GF_GRAY)).toBe(true);
  });

  it('mapBlockCodeToGarbageFlavor offsets by GF_GRAY + 1', () => {
    expect(mapBlockCodeToGarbageFlavor(0)).toBe(GF_GRAY + 1);
    expect(mapBlockCodeToGarbageFlavor(3)).toBe(GF_GRAY + 1 + 3);
  });
});

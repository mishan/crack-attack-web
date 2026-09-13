import { describe, expect, it } from 'vitest';
import {
  type BoardFit,
  type Rect,
  fitCameraDistance,
  frameBoard,
  frameBoards,
} from './cameraFit.js';

/** Half-width of the frame at the board plane for a camera `d` away. */
function halfWidthAt(d: number, fovDeg: number, aspect: number): number {
  return d * Math.tan((fovDeg * Math.PI) / 360) * aspect;
}

const FIT: BoardFit = { baseDistance: 18, fovDeg: 48, halfExtentX: 4, halfExtentY: 7 };

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function within(r: Rect, width: number, height: number): boolean {
  const e = 1e-9;
  return r.left >= -e && r.top >= -e && r.right <= width + e && r.bottom <= height + e;
}

describe('fitCameraDistance', () => {
  it('keeps the base distance when the viewport is wide enough', () => {
    expect(fitCameraDistance(18, 48, 16 / 9, 4)).toBe(18);
    expect(fitCameraDistance(18, 48, 1, 4)).toBe(18);
  });

  it('dollies back on a narrow viewport so the full width fits', () => {
    // Half of a portrait phone (≈213×952 CSS px).
    const aspect = 213 / 952;
    const d = fitCameraDistance(18, 48, aspect, 4);
    expect(d).toBeGreaterThan(18);
    expect(halfWidthAt(d, 48, aspect)).toBeCloseTo(4, 6);
  });

  it('switches over exactly where the base framing stops fitting', () => {
    const edge = 4 / (18 * Math.tan((48 * Math.PI) / 360));
    expect(fitCameraDistance(18, 48, edge + 0.01, 4)).toBe(18);
    expect(fitCameraDistance(18, 48, edge - 0.01, 4)).toBeGreaterThan(18);
  });

  it('stays finite for a degenerate zero-width viewport', () => {
    expect(Number.isFinite(fitCameraDistance(18, 48, 0, 4))).toBe(true);
  });
});

describe('frameBoard', () => {
  it('with no chrome, is the plain width fit, centred', () => {
    const f = frameBoard(FIT, 427, 952);
    expect(f.distance).toBe(fitCameraDistance(18, 48, 427 / 952, 4));
    expect((f.rect.top + f.rect.bottom) / 2).toBeCloseTo(476, 6);
    expect(f.rect.right - f.rect.left).toBeCloseTo(427, 6); // width-limited: fills it
  });

  it('ignores chrome that does not cover the board (a desktop side HUD)', () => {
    const plain = frameBoard(FIT, 1280, 800);
    const hud = { left: 12, top: 12, right: 200, bottom: 160 };
    expect(frameBoard(FIT, 1280, 800, [hud])).toEqual(plain);
  });

  it('moves the board up and out from under bottom touch controls', () => {
    const pad = { left: 18, top: 740, right: 210, bottom: 928 };
    const f = frameBoard(FIT, 427, 952, [pad]);
    expect(overlaps(f.rect, pad)).toBe(false);
    expect(within(f.rect, 427, 952)).toBe(true);
  });

  it('shrinks to fit between top and bottom chrome', () => {
    const hud = { left: 12, top: 12, right: 150, bottom: 144 };
    const pad = { left: 18, top: 740, right: 210, bottom: 928 };
    const f = frameBoard(FIT, 427, 952, [hud, pad]);
    expect(overlaps(f.rect, hud)).toBe(false);
    expect(overlaps(f.rect, pad)).toBe(false);
    expect(within(f.rect, 427, 952)).toBe(true);
    expect(f.distance).toBeGreaterThan(frameBoard(FIT, 427, 952).distance);
  });

  it('slides sideways at full size where there is room (landscape corner pad)', () => {
    const plain = frameBoard(FIT, 952, 427);
    // A corner pad over the plain board's lower-left.
    const pad = { left: 18, top: 200, right: plain.rect.left + 60, bottom: 410 };
    const f = frameBoard(FIT, 952, 427, [pad]);
    expect(f.distance).toBe(plain.distance);
    expect(f.rect.top).toBe(plain.rect.top);
    expect(f.rect.left).toBeCloseTo(pad.right, 6);
  });

  it('keeps the plain framing when no big-enough board fits clear', () => {
    const wall = { left: 0, top: 0, right: 952, bottom: 427 };
    expect(frameBoard(FIT, 952, 427, [wall])).toEqual(frameBoard(FIT, 952, 427));
  });
});

describe('frameBoards', () => {
  it('gives side-by-side boards one size and height, sliding each sideways', () => {
    // Landscape phone halves: a d-pad at the left board's lower-left, action
    // buttons at the right board's lower-right.
    const plain = frameBoard(FIT, 476, 427);
    const pad = { left: 18, top: 220, right: plain.rect.left + 40, bottom: 410 };
    const actions = { left: plain.rect.right - 40, top: 220, right: 460, bottom: 410 };
    const [l, r] = frameBoards(FIT, [
      { width: 476, height: 427, chrome: [pad] },
      { width: 476, height: 427, chrome: [actions] },
    ]);
    expect(l!.distance).toBe(r!.distance);
    expect(l!.rect.top).toBe(r!.rect.top);
    expect(overlaps(l!.rect, pad)).toBe(false);
    expect(overlaps(r!.rect, actions)).toBe(false);
    expect(l!.rect.left).toBeGreaterThan(plain.rect.left); // slid right
    expect(r!.rect.left).toBeLessThan(plain.rect.left); // slid left
  });

  it('moves both boards down together for chrome over just one', () => {
    const plain = frameBoard(FIT, 640, 800);
    const audio = { left: 275, top: 12, right: 470, bottom: plain.rect.top + 2 };
    const [l, r] = frameBoards(FIT, [
      { width: 640, height: 800, chrome: [] },
      { width: 640, height: 800, chrome: [audio] },
    ]);
    expect(overlaps(r!.rect, audio)).toBe(false);
    expect(l!.rect.top).toBe(r!.rect.top);
    expect(l!.rect.top).toBeGreaterThan(plain.rect.top);
  });
});

import { describe, expect, it } from 'vitest';
import { type BoardFit, type Rect, fitCameraDistance, frameBoard } from './cameraFit.js';

/** Half-width of the frame at the board plane for a camera `d` away. */
function halfWidthAt(d: number, fovDeg: number, aspect: number): number {
  return d * Math.tan((fovDeg * Math.PI) / 360) * aspect;
}

const FIT: BoardFit = { baseDistance: 18, fovDeg: 48, halfExtentX: 4, halfExtentY: 7 };

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
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
    expect(f.shiftPx).toBe(0);
    expect((f.rect.top + f.rect.bottom) / 2).toBeCloseTo(476, 6);
    expect(f.rect.right - f.rect.left).toBeCloseTo(427, 6); // width-limited: fills it
  });

  it('ignores chrome that does not cover the board (a desktop side HUD)', () => {
    const plain = frameBoard(FIT, 1280, 800);
    const hud = { left: 12, top: 12, right: 200, bottom: 160 };
    expect(frameBoard(FIT, 1280, 800, [hud])).toEqual(plain);
  });

  it('slides the board up and out from under bottom touch controls', () => {
    const pad = { left: 18, top: 740, right: 210, bottom: 928 };
    const f = frameBoard(FIT, 427, 952, [pad]);
    expect(f.shiftPx).toBeGreaterThan(0);
    expect(overlaps(f.rect, pad)).toBe(false);
    expect(f.rect.top).toBeGreaterThanOrEqual(-1e-9);
  });

  it('fits between top and bottom chrome', () => {
    const hud = { left: 12, top: 12, right: 150, bottom: 144 };
    const pad = { left: 18, top: 740, right: 210, bottom: 928 };
    const f = frameBoard(FIT, 427, 952, [hud, pad]);
    expect(f.rect.top).toBeGreaterThanOrEqual(144 - 1e-9);
    expect(f.rect.bottom).toBeLessThanOrEqual(740 + 1e-9);
    expect(f.distance).toBeGreaterThan(frameBoard(FIT, 427, 952).distance);
  });

  it('re-checks after sliding, so it does not slide into other chrome', () => {
    const plain = frameBoard(FIT, 427, 952).rect;
    // Clear of the plain framing, but in the way once the pad pushes it up.
    const hud = { left: 0, top: 0, right: 427, bottom: plain.top - 1 };
    const pad = { left: 0, top: plain.bottom - 60, right: 427, bottom: 952 };
    const f = frameBoard(FIT, 427, 952, [hud, pad]);
    expect(overlaps(f.rect, hud)).toBe(false);
    expect(overlaps(f.rect, pad)).toBe(false);
  });

  it('leaves chrome overlapping when avoiding it would leave too little room', () => {
    // A landscape phone: a tall pad over most of the height.
    const pad = { left: 0, top: 150, right: 952, bottom: 427 };
    expect(frameBoard(FIT, 952, 427, [pad])).toEqual(frameBoard(FIT, 952, 427));
  });

  it('still avoids small chrome when a big piece has to be left overlapping', () => {
    const audio = { left: 0, top: 12, right: 952, bottom: 44 };
    const pad = { left: 0, top: 150, right: 952, bottom: 427 };
    const f = frameBoard(FIT, 952, 427, [pad, audio]);
    expect(f.rect.top).toBeGreaterThanOrEqual(44 - 1e-9);
    expect(overlaps(f.rect, pad)).toBe(true);
  });
});

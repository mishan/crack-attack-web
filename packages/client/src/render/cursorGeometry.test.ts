import { describe, expect, it } from 'vitest';
import { swapperCursorGeometry } from './cursorGeometry.js';

describe('swapperCursorGeometry', () => {
  it('bakes four mirrored corners (16 tris each) with matching normals', () => {
    const geom = swapperCursorGeometry();
    const pos = geom.getAttribute('position');
    const nor = geom.getAttribute('normal');
    // 4 corners × 16 triangles × 3 verts = 192 vertices.
    expect(pos.count).toBe(4 * 16 * 3);
    expect(nor.count).toBe(pos.count);
  });

  it('spans the whole 2×1 box — corners reach all four quadrants', () => {
    const p = swapperCursorGeometry().getAttribute('position');
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < p.count; i++) {
      minX = Math.min(minX, p.getX(i));
      maxX = Math.max(maxX, p.getX(i));
      minY = Math.min(minY, p.getY(i));
      maxY = Math.max(maxY, p.getY(i));
    }
    // Box is 2 wide (±1) and 1 tall (±0.5); the brackets overshoot slightly.
    expect(maxX).toBeCloseTo(1.05);
    expect(minX).toBeCloseTo(-1.05);
    expect(maxY).toBeCloseTo(0.55);
    expect(minY).toBeCloseTo(-0.55);
  });
});

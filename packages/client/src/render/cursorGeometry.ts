/**
 * cursorGeometry.ts — the swap cursor (reticle) geometry.
 *
 * A faithful port of `obj_swapper.cxx`: the reference builds one beveled corner
 * bracket (`swapper_list`, 16 triangles with a raised front ridge) and draws it
 * four times, mirrored via `glScalef(±1, ±1, 1)`, to bracket the four corners of
 * the 2×1 selection box — the classic open-corner targeting reticle, not a
 * closed outline. `DrawSwapper.cxx` colours it white (`swapper_colors[0]`).
 *
 * The reference authors the geometry for a 2-unit cell (`DC_GRID_ELEMENT_LENGTH`);
 * our cell is 1 unit, so the vertices below are pre-scaled by 0.5 and z-shifted
 * so the base sits at z=0 with the ridge at +0.05. We bake all four mirrored
 * corners into one `BufferGeometry` (one draw call), with per-face normals
 * computed exactly as `Displayer::drawTriangle` does, so the bevel catches the
 * headlight like the level-light arrows.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { BufferGeometry, Float32BufferAttribute } from 'three';

// One corner bracket (bottom-right), 16 triangles = 48 vertices, computed from
// the SG_* constants in obj_swapper.cxx and pre-scaled to our 1-unit cell.
// prettier-ignore
const CORNER_TRIS = [
  0.6, -0.5, 0.0, 0.68, -0.5, 0.05, 0.65, -0.45, 0.0,
  0.65, -0.45, 0.0, 0.68, -0.5, 0.05, 0.8, -0.45, 0.0,
  0.8, -0.45, 0.0, 0.68, -0.5, 0.05, 0.8207, -0.5, 0.05,
  0.8, -0.45, 0.0, 0.8207, -0.5, 0.05, 0.95, -0.3, 0.0,
  0.95, -0.3, 0.0, 0.8207, -0.5, 0.05, 1.0, -0.3207, 0.05,
  0.95, -0.3, 0.0, 1.0, -0.3207, 0.05, 0.95, -0.15, 0.0,
  0.95, -0.15, 0.0, 1.0, -0.3207, 0.05, 1.0, -0.18, 0.05,
  0.95, -0.15, 0.0, 1.0, -0.18, 0.05, 1.0, -0.1, 0.0,
  0.6, -0.5, 0.0, 0.65, -0.55, 0.0, 0.68, -0.5, 0.05,
  0.68, -0.5, 0.05, 0.65, -0.55, 0.0, 0.8207, -0.5, 0.05,
  0.8207, -0.5, 0.05, 0.65, -0.55, 0.0, 0.8414, -0.55, 0.0,
  0.8207, -0.5, 0.05, 0.8414, -0.55, 0.0, 1.0, -0.3207, 0.05,
  1.0, -0.3207, 0.05, 0.8414, -0.55, 0.0, 1.05, -0.3414, 0.0,
  1.0, -0.3207, 0.05, 1.05, -0.3414, 0.0, 1.0, -0.18, 0.05,
  1.0, -0.18, 0.05, 1.05, -0.3414, 0.0, 1.05, -0.15, 0.0,
  1.0, -0.1, 0.0, 1.0, -0.18, 0.05, 1.05, -0.15, 0.0,
];

// The four corners, as the reference's cumulative glScalef flips: (1,1),
// (-1,-1), (1,-1), (-1,1) — the base corner mirrored into all four.
const CORNER_SCALES: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

/**
 * The full four-corner reticle for the 2×1 selection box, centred on the box
 * (corners at ±1 in x, ±0.5 in y). Position the mesh at the cursor's shared-edge
 * cell to place it.
 */
export function swapperCursorGeometry(): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];

  for (const [sx, sy] of CORNER_SCALES) {
    for (let i = 0; i < CORNER_TRIS.length; i += 9) {
      const a = [CORNER_TRIS[i]! * sx, CORNER_TRIS[i + 1]! * sy, CORNER_TRIS[i + 2]!];
      const b = [CORNER_TRIS[i + 3]! * sx, CORNER_TRIS[i + 4]! * sy, CORNER_TRIS[i + 5]!];
      const c = [CORNER_TRIS[i + 6]! * sx, CORNER_TRIS[i + 7]! * sy, CORNER_TRIS[i + 8]!];
      // Face normal (c - a) × (a - b), as Displayer::drawTriangle computes it,
      // from the *mirrored* verts so it stays outward-facing per corner.
      const nx = (c[1]! - a[1]!) * (a[2]! - b[2]!) - (a[1]! - b[1]!) * (c[2]! - a[2]!);
      const ny = (c[2]! - a[2]!) * (a[0]! - b[0]!) - (a[2]! - b[2]!) * (c[0]! - a[0]!);
      const nz = (c[0]! - a[0]!) * (a[1]! - b[1]!) - (a[0]! - b[0]!) * (c[1]! - a[1]!);
      const len = Math.hypot(nx, ny, nz) || 1;
      for (const p of [a, b, c]) {
        position.push(p[0]!, p[1]!, p[2]!);
        normal.push(nx / len, ny / len, nz / len);
      }
    }
  }

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(position, 3));
  geom.setAttribute('normal', new Float32BufferAttribute(normal, 3));
  return geom;
}

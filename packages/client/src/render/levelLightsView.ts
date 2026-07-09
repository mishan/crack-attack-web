/**
 * levelLightsView.ts — draws the side "level light" arrow columns.
 *
 * A column of {@link LEVEL_LIGHT_COUNT} arrow lights down each side of the board,
 * aligned with the playable rows and pointing *outward* (away from the board, as
 * in the original). Each frame their colour is set from the stack height (red
 * below the top, blue above), faithful to `LevelLights`.
 *
 * The arrow is the reference's 3-facet chevron (`obj_level_lights.cxx`): a flat
 * base with a raised centre ridge, so its three flat-shaded facets catch the
 * headlight differently and read as a beveled 3D shape. NOTE: the shading model
 * intentionally *diverges* from the reference for robustness — the original emits
 * the red/blue colour (`GL_EMISSION`) over black diffuse with a gray specular
 * (`GL_SPECULAR` 0.8 / `GL_SHININESS` 2). Here that colour drives the *diffuse*
 * instead (lit by the scene headlight), with a gray specular on top. On our black
 * background this reads the same, and it avoids a per-instance emissive shader
 * patch that proved fragile (it blanked the arrows).
 *
 * In solo both sides show the same local set (the right column is mirrored), as
 * the original does when there's no opponent.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshPhongMaterial,
  type Scene,
} from 'three';
import { LEVEL_LIGHT_COUNT, isLevelLightRed } from '../view/levelLights.js';

/** Gap between the board edge and the (inner, tail) end of the light column, in cells. */
const SIDE_MARGIN = 0.7;
/** Per-instance colours (DC_LEVEL_LIGHT_RED / _BLUE ≈ 0.7, brightened to read on black). */
const RED = new Color(0.95, 0.1, 0.1);
const BLUE = new Color(0.16, 0.32, 1.0);

// Arrow shape from obj_level_lights.cxx (LG_A..D), scaled from the reference's
// 2-unit cells to our 1-unit cells (≈0.5) so it matches the original's small size,
// pointing toward +x. `Pd` is the raised centre ridge (+z toward the viewer) that
// gives the chevron its bevel.
const S = 0.55;
const P0: [number, number, number] = [0, 0, 0]; // tail
const PD: [number, number, number] = [0.72 * S, 0, 0.3 * S]; // raised front ridge
const PT: [number, number, number] = [0.96 * S, 0.36 * S, 0]; // top corner
const PB: [number, number, number] = [0.96 * S, -0.36 * S, 0]; // bottom corner

/** The 3-triangle chevron with faithful per-facet (flat) normals. */
function arrowGeometry(): BufferGeometry {
  const tris: Array<[number[], number[], number[]]> = [
    [P0, PD, PT],
    [PT, PD, PB],
    [P0, PB, PD],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  for (const [a, b, c] of tris) {
    // Face normal, matching Displayer::drawTriangle: (c - a) × (a - b).
    const nx = (c[1]! - a[1]!) * (a[2]! - b[2]!) - (a[1]! - b[1]!) * (c[2]! - a[2]!);
    const ny = (c[2]! - a[2]!) * (a[0]! - b[0]!) - (a[2]! - b[2]!) * (c[0]! - a[0]!);
    const nz = (c[0]! - a[0]!) * (a[1]! - b[1]!) - (a[0]! - b[0]!) * (c[1]! - a[1]!);
    const len = Math.hypot(nx, ny, nz) || 1;
    for (const p of [a, b, c]) {
      positions.push(p[0]!, p[1]!, p[2]!);
      normals.push(nx / len, ny / len, nz / len);
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geom;
}

/**
 * Glossy material: the per-instance colour is the diffuse (so the three facets
 * shade under the scene headlight → the beveled look), with a gray specular for
 * the sheen. Kept simple/robust — no per-instance emissive shader hack.
 */
function lightMaterial(): MeshPhongMaterial {
  return new MeshPhongMaterial({
    specular: new Color(0.6, 0.6, 0.6),
    shininess: 8, // broad, soft highlight across the facets
    side: DoubleSide,
  });
}

export class LevelLightsView {
  private readonly mesh: InstancedMesh;
  private lastTop = Number.NaN;

  constructor(scene: Scene, halfW: number, halfH: number) {
    this.mesh = new InstancedMesh(arrowGeometry(), lightMaterial(), LEVEL_LIGHT_COUNT * 2);
    this.mesh.position.z = 0.6; // in front of the block faces
    this.mesh.renderOrder = 4;
    this.mesh.frustumCulled = false; // tiny procedural geometry off to the sides

    // Place the two columns once (only their colour changes per frame). Arrows
    // point *outward* (away from the board), as in the original: the right column
    // keeps the +x apex, the left column is turned 180° about Z to point -x. A
    // rotation (not a negative scale) keeps the normals valid so both shade.
    const m = new Matrix4();
    let i = 0;
    for (const side of [-1, 1] as const) {
      for (let n = 0; n < LEVEL_LIGHT_COUNT; n++) {
        if (side < 0) m.makeRotationZ(Math.PI);
        else m.identity();
        m.setPosition(side * (halfW + SIDE_MARGIN), n + 1 - halfH, 0);
        this.mesh.setMatrixAt(i++, m);
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    // Seed the instance colours (also allocates instanceColor before first render).
    this.update(0);
    scene.add(this.mesh);
  }

  /** Recolour the lights for the current stack height (`grid.top_effective_row`). */
  update(topEffectiveRow: number): void {
    if (topEffectiveRow === this.lastTop) return; // colours only change with the stack top
    this.lastTop = topEffectiveRow;
    for (let i = 0; i < this.mesh.count; i++) {
      const n = i % LEVEL_LIGHT_COUNT; // both columns share the same per-row state
      this.mesh.setColorAt(i, isLevelLightRed(n, topEffectiveRow) ? RED : BLUE);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

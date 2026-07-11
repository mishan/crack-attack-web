/**
 * loseBarView.ts — the stylized danger bar under the board (LoseBar).
 *
 * A horizontal tube beneath the play area whose fill and colour track the loss
 * countdown, driven by the pure {@link LoseBarState}. A small shader paints the
 * two-colour sweep (the alert colour filling in from the left over the lower
 * colour, boundary at `bar`) plus a soft cylindrical highlight so it reads as a
 * rounded tube — faithful in spirit to the reference's textured losebar
 * (Displayer.h:504-534, DrawExternalCandy.cxx), restyled for our renderer.
 *
 * One per board (like {@link LevelLightsView}); ticks with the sim.
 */

import { Mesh, PlaneGeometry, ShaderMaterial, type Scene, Vector3 } from 'three';
import { LoseBarState } from '../view/loseBar.js';

/** Bar height in cells. */
const BAR_HEIGHT = 0.6;
/** Gap between the board's bottom row and the bar, in cells. */
const BOTTOM_MARGIN = 1.0;
/** Soft width (in uv) of the colour boundary. */
const EDGE_SOFTNESS = 0.05;

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision mediump float;
  varying vec2 vUv;
  uniform vec3 uColor1; // filled (alert) colour, left of the boundary
  uniform vec3 uColor2; // empty (lower) colour, right of the boundary
  uniform float uSplit; // fill fraction 0..1
  uniform float uEdge;  // boundary softness

  void main() {
    // Left of the boundary is the filled colour, right is the empty colour.
    float m = smoothstep(uSplit - uEdge, uSplit + uEdge, vUv.x);
    vec3 c = mix(uColor1, uColor2, m);

    // Cylindrical shading: bright down the centre, darker at the rounded edges,
    // with a thin specular sheen just above centre — the "tube" look.
    float d = abs(vUv.y - 0.5) * 2.0;          // 0 centre → 1 edge
    float shade = 0.55 + 0.45 * (1.0 - d * d); // parabolic falloff
    float sheen = smoothstep(0.62, 0.5, vUv.y) * smoothstep(0.34, 0.5, vUv.y);
    vec3 col = c * shade + sheen * 0.25;

    // Round the caps: fade alpha to zero outside a stadium (rounded-rect) mask.
    float ar = ${(1 / BAR_HEIGHT).toFixed(3)}; // half-width / half-height ratio proxy
    float edgeX = min(vUv.x, 1.0 - vUv.x) * ar; // scaled distance to nearer cap
    float alpha = smoothstep(0.0, 0.06, min(edgeX, 1.0 - d));
    gl_FragColor = vec4(col, alpha);
  }
`;

export class LoseBarView {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly state = new LoseBarState();

  constructor(scene: Scene, halfW: number, halfH: number) {
    const width = 2 * halfW + 2; // a touch wider than the board (≈DC_LOSEBAR_LENGTH)
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      // The rounded-cap mask makes fragments fully transparent; don't let them
      // write depth (that would occlude things behind the bar's rectangle).
      // Matches the other transparent renderables (SparklesView). depthTest stays
      // on, so the bar is still correctly occluded by anything in front of it.
      depthWrite: false,
      uniforms: {
        uColor1: { value: new Vector3(0, 0, 1) },
        uColor2: { value: new Vector3(0, 0, 1) },
        uSplit: { value: 0 },
        uEdge: { value: EDGE_SOFTNESS },
      },
    });
    this.mesh = new Mesh(new PlaneGeometry(width, BAR_HEIGHT), this.material);
    this.mesh.position.set(0, -halfH - BOTTOM_MARGIN, 0.4);
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.sync();
  }

  /** Reset for a new game (LoseBar::initialize/gameStart). */
  reset(): void {
    this.state.gameStart();
    this.sync();
  }

  /**
   * Advance the bar by the sim ticks stepped this frame from the Creep loss
   * state, then refresh the shader. `creepFreeze`/`lossAlarm` are the current
   * (post-step) values; during multi-tick catch-up they're applied to each tick
   * (an approximation only relevant to resume/spectate, exact at 1 tick/frame).
   */
  update(steppedTicks: number, creepFreeze: boolean, lossAlarm: number): void {
    for (let t = 0; t < steppedTicks; t++) this.state.tick(creepFreeze, lossAlarm);
    this.sync();
  }

  private sync(): void {
    // Pass the faithful RGB straight through (no Color/sRGB conversion) — the raw
    // ShaderMaterial writes gl_FragColor directly.
    const [r1, g1, b1] = this.state.color1();
    const [r2, g2, b2] = this.state.color2();
    (this.material.uniforms.uColor1!.value as Vector3).set(r1, g1, b1);
    (this.material.uniforms.uColor2!.value as Vector3).set(r2, g2, b2);
    this.material.uniforms.uSplit!.value = Math.max(0, Math.min(1, this.state.bar));
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

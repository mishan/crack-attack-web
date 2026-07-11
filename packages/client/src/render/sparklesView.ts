/**
 * sparklesView.ts — draws the death sparks and reward motes.
 *
 * Two instanced meshes over the pure {@link Sparkles} system: sparks as small
 * four-pointed stars colored by block flavor (with the reference's end-of-life
 * fade and white pulse), motes as five-pointed stars sized/colored by the
 * level tables. Additive blending stands in for the reference's blended
 * alpha-mask sprites — fades premultiply into the instance color, which under
 * additive blending reads as transparency on our dark background.
 *
 * Divergence note: the C++ gives each mote type its own star texture
 * (4/5/6-point, special, multiplier one/two/three). Here one procedural
 * 5-point star covers all types — at mote sizes the silhouette differences
 * barely read, and it avoids seven texture conversions. Revisit if wanted.
 */

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  AdditiveBlending,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';
import { generateSeed, Rng } from '@crack-attack/core';
import {
  DC_MAX_MOTE_NUMBER,
  DC_MAX_SPARK_NUMBER,
  Sparkles,
  moteTint,
  sparkTint,
} from '../view/sparkles.js';
import { blockColor } from './palette.js';

/** Spark star outer radius in cells (the reference's DC_SPARKLE_LENGTH scale). */
const SPARK_RADIUS = 0.16;
/** Mote base radius in cells (multiplied by the per-level size, 2.0–5.1). */
const MOTE_RADIUS = 0.11;

/** Flat n-pointed star (triangle fan between outer points and inner valleys). */
function starGeometry(points: number, outer: number, inner: number): BufferGeometry {
  const positions: number[] = [];
  for (let p = 0; p < points; p++) {
    const a0 = (p / points) * 2 * Math.PI;
    const a1 = ((p + 0.5) / points) * 2 * Math.PI;
    const a2 = ((p + 1) / points) * 2 * Math.PI;
    // outer point, inner valley, center — two triangles per point
    positions.push(0, 0, 0, Math.cos(a0) * outer, Math.sin(a0) * outer, 0);
    positions.push(Math.cos(a1) * inner, Math.sin(a1) * inner, 0);
    positions.push(0, 0, 0, Math.cos(a1) * inner, Math.sin(a1) * inner, 0);
    positions.push(Math.cos(a2) * outer, Math.sin(a2) * outer, 0);
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geom;
}

function sparkleMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: DoubleSide,
  });
}

const HIDDEN = new Matrix4().makeScale(0, 0, 0);

export class SparklesView {
  private readonly system: Sparkles;
  private readonly sparkMesh: InstancedMesh;
  private readonly moteMesh: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly zAxis = new Vector3(0, 0, 1);
  private readonly color = new Color();
  private readonly white = new Color(1, 1, 1);

  constructor(scene: Scene, halfW: number, halfH: number) {
    // Kill bound: one cell above the visible top, in the reference's world units.
    this.system = new Sparkles(new Rng(generateSeed()), halfW, halfH, (halfH + 1) * 2);

    this.sparkMesh = new InstancedMesh(
      starGeometry(4, SPARK_RADIUS, SPARK_RADIUS * 0.38),
      sparkleMaterial(),
      DC_MAX_SPARK_NUMBER,
    );
    this.moteMesh = new InstancedMesh(
      starGeometry(5, MOTE_RADIUS, MOTE_RADIUS * 0.45),
      sparkleMaterial(),
      DC_MAX_MOTE_NUMBER,
    );
    for (const mesh of [this.sparkMesh, this.moteMesh]) {
      mesh.renderOrder = 5; // over blocks and garbage
      mesh.frustumCulled = false;
      for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, HIDDEN);
      // Flush the hidden matrices now: without this, a frame rendered before
      // the first sync() would draw every instance at the origin (identity).
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }
  }

  /** Death-spark burst (drained SparkEvent). */
  spawnSparks(x: number, y: number, flavor: number, count: number): void {
    this.system.createBlockDeathSpark(x, y, flavor, count);
  }

  /** Reward mote (drained MoteEvent). */
  spawnMote(x: number, y: number, level: number, sibling: number): void {
    this.system.createRewardMote(x, y, level, sibling);
  }

  /** Celebration firework spark from a source (0..4) in a block colour (0..4). */
  spawnCelebrationSpark(source: number, color: number): void {
    this.system.createCelebrationSpark(source, color);
  }

  /** Advance the particle sim by the frame's stepped ticks (freezes with the sim). */
  advance(ticks: number): void {
    for (let t = 0; t < ticks; t++) this.system.timeStep();
  }

  /** Mirror the particle state onto the instances. Call once per rendered frame. */
  sync(): void {
    for (let i = 0; i < DC_MAX_SPARK_NUMBER; i++) {
      const spark = this.system.sparks[i]!;
      if (!spark.active) {
        this.sparkMesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      this.q.setFromAxisAngle(this.zAxis, (spark.a * Math.PI) / 180);
      this.v.set(spark.x / 2, spark.y / 2, 0.7); // world units → cells
      this.s.set(spark.size, spark.size, 1);
      this.m.compose(this.v, this.q, this.s);
      this.sparkMesh.setMatrixAt(i, this.m);

      const { alpha, whiteMix } = sparkTint(spark.life_time);
      this.color.copy(blockColor(spark.color)).lerp(this.white, whiteMix);
      this.color.multiplyScalar(alpha); // additive blending: darker = fainter
      this.sparkMesh.setColorAt(i, this.color);
    }
    this.sparkMesh.instanceMatrix.needsUpdate = true;
    if (this.sparkMesh.instanceColor) this.sparkMesh.instanceColor.needsUpdate = true;

    for (let i = 0; i < DC_MAX_MOTE_NUMBER; i++) {
      const mote = this.system.motes[i]!;
      if (!mote.active) {
        this.moteMesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      this.q.setFromAxisAngle(this.zAxis, (mote.a * Math.PI) / 180);
      this.v.set(mote.x / 2, mote.y / 2, 0.75);
      this.s.set(mote.size, mote.size, 1);
      this.m.compose(this.v, this.q, this.s);
      this.moteMesh.setMatrixAt(i, this.m);

      const [r, g, b, a] = moteTint(mote);
      this.color.setRGB(r * a, g * a, b * a);
      this.moteMesh.setColorAt(i, this.color);
    }
    this.moteMesh.instanceMatrix.needsUpdate = true;
    if (this.moteMesh.instanceColor) this.moteMesh.instanceColor.needsUpdate = true;
  }

  /** Clear all particles (restart/rematch). */
  clear(): void {
    this.system.gameStart();
    this.sync();
  }
}

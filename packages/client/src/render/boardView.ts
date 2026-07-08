/**
 * boardView.ts — the Three.js renderer for one board.
 *
 * Deliberately dumb: it owns the scene/camera/renderer and, each frame, mirrors
 * a {@link BoardViewModel} onto instanced meshes. It knows nothing about the
 * simulation — it only draws sprites at the positions the view-model computed.
 * Swapping the visuals (glTF models, shaders, effects) touches only this file.
 *
 * Grid cell (x, renderY) maps to world (x - (W-1)/2, renderY - (Hvis-1)/2, 0),
 * so the board is centred on the origin and the camera frames it.
 */

import {
  AmbientLight,
  BoxGeometry,
  type BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Fog,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GC_BLOCK_STORE_SIZE, GC_GARBAGE_STORE_SIZE } from '@crack-attack/core';
import type { BoardViewModel } from '../view/boardViewModel.js';
import { blockColor, garbageColor } from './palette.js';

const CELL = 1;
const BLOCK_SIZE = 0.92;

export class BoardView {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;

  private readonly blocks: InstancedMesh;
  private readonly garbage: InstancedMesh;
  private readonly cursor: LineSegments;

  private readonly halfW: number;
  private readonly halfH: number;

  // Scratch objects reused every frame (no per-frame allocation).
  private readonly m = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly rot = new Quaternion();
  private readonly color = new Color();

  constructor(container: HTMLElement, width: number, visibleHeight: number) {
    this.halfW = (width - 1) / 2;
    this.halfH = (visibleHeight - 1) / 2;

    this.scene.background = new Color(0x0b0d12);
    this.scene.fog = new Fog(0x0b0d12, 22, 40);

    this.camera = new PerspectiveCamera(48, 1, 0.1, 100);
    this.camera.position.set(0, 0.5, Math.max(14, visibleHeight * 1.5));
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new AmbientLight(0xffffff, 0.65));
    const key = new DirectionalLight(0xffffff, 1.1);
    key.position.set(4, 8, 10);
    this.scene.add(key);

    // A subtle back wall behind the play area for depth.
    const wall = new Mesh(
      new PlaneGeometry(width + 4, visibleHeight + 4),
      new MeshStandardMaterial({ color: 0x141821, roughness: 1 }),
    );
    wall.position.set(0, 0, -0.8);
    this.scene.add(wall);

    const cube = new BoxGeometry(CELL, CELL, CELL);

    // Per-instance colours come from `InstancedMesh.setColorAt` (→ instanceColor).
    // Three enables the `USE_INSTANCING_COLOR` shader path automatically when an
    // instanceColor attribute is present — no `vertexColors: true` needed (that
    // flag is for per-*vertex* colours, a different attribute).
    this.blocks = new InstancedMesh(
      new BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE),
      new MeshStandardMaterial({ roughness: 0.45, metalness: 0.05 }),
      GC_BLOCK_STORE_SIZE,
    );
    this.blocks.count = 0;
    this.scene.add(this.blocks);

    this.garbage = new InstancedMesh(
      cube,
      new MeshStandardMaterial({ roughness: 0.8, metalness: 0.0 }),
      GC_GARBAGE_STORE_SIZE,
    );
    this.garbage.count = 0;
    this.scene.add(this.garbage);

    // Swap cursor: a bright 2×1 wire frame drawn in front of the blocks.
    const frame = new EdgesGeometry(new BoxGeometry(2 * CELL + 0.12, CELL + 0.12, CELL + 0.12));
    this.cursor = new LineSegments(frame, new LineBasicMaterial({ color: 0xffffff }));
    this.scene.add(this.cursor);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    container.appendChild(this.renderer.domElement);

    // Upgrade the block geometry from the fallback cube to the real rounded-cube
    // model (converted by tools/obj2gltf). Async; blocks render as boxes until it
    // arrives, and stay boxes if the fetch fails.
    void this.loadBlockModel();
  }

  /**
   * Fetch the glTF block model and swap its geometry into the block instances.
   * The per-instance colours (instanceColor) and material are unaffected — only
   * the shape changes. Normalizes the model to `BLOCK_SIZE` and centres it.
   */
  private async loadBlockModel(): Promise<void> {
    try {
      const url = new URL('models/block.gltf', document.baseURI).href;
      const gltf = await new GLTFLoader().loadAsync(url);

      let geometry: BufferGeometry | null = null;
      gltf.scene.traverse((o) => {
        if (!geometry && (o as Mesh).isMesh) geometry = (o as Mesh).geometry as BufferGeometry;
      });
      if (!geometry) return; // no mesh in the model → keep the box fallback

      // Centre at the origin and scale so the largest dimension fills a cell.
      const geom = geometry as BufferGeometry;
      geom.computeBoundingBox();
      const box = geom.boundingBox;
      if (box) {
        const size = box.getSize(new Vector3());
        const center = box.getCenter(new Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        geom.translate(-center.x, -center.y, -center.z);
        geom.scale(BLOCK_SIZE / maxDim, BLOCK_SIZE / maxDim, BLOCK_SIZE / maxDim);
      }

      const old = this.blocks.geometry;
      this.blocks.geometry = geom;
      old.dispose();
    } catch {
      // Keep the box fallback; the model is a visual upgrade, not required.
    }
  }

  /** World position for a cell (writes into `this.pos`). */
  private place(x: number, y: number, z = 0): Vector3 {
    return this.pos.set(x - this.halfW, y - this.halfH, z);
  }

  /** Mirror `vm` onto the meshes. Call once per rendered frame. */
  update(vm: BoardViewModel): void {
    // Blocks.
    let i = 0;
    for (const b of vm.blocks) {
      this.place(b.x, b.renderY);
      this.scl.setScalar(b.phase === 'dying' ? 0.6 : 1);
      this.m.compose(this.pos, this.rot, this.scl);
      this.blocks.setMatrixAt(i, this.m);
      this.color.copy(blockColor(b.flavor));
      if (b.phase === 'awaking') this.color.multiplyScalar(0.5);
      // Dim the incoming creep row so it reads as "not yet in play" — the lowest
      // full-brightness row is the bottom *playable* row the cursor can reach.
      if (b.preview) this.color.multiplyScalar(0.35);
      this.blocks.setColorAt(i, this.color);
      i++;
    }
    this.blocks.count = i;
    this.blocks.instanceMatrix.needsUpdate = true;
    if (this.blocks.instanceColor) this.blocks.instanceColor.needsUpdate = true;

    // Garbage slabs (per-instance scale encodes width × height).
    let g = 0;
    for (const s of vm.garbage) {
      const cx = s.x + (s.width - 1) / 2;
      const cy = s.renderY + (s.height - 1) / 2;
      this.place(cx, cy);
      this.scl.set(s.width * 0.98, s.height * 0.98, 0.98);
      this.m.compose(this.pos, this.rot, this.scl);
      this.garbage.setMatrixAt(g, this.m);
      this.color.copy(garbageColor(s.flavor));
      if (s.awaking) this.color.multiplyScalar(0.6);
      this.garbage.setColorAt(g, this.color);
      g++;
    }
    this.garbage.count = g;
    this.garbage.instanceMatrix.needsUpdate = true;
    if (this.garbage.instanceColor) this.garbage.instanceColor.needsUpdate = true;

    // Cursor spans cells (x, y) and (x+1, y): centre on the shared edge. Use the
    // cursor's `renderY` (creep-adjusted) so it rides with the blocks it selects.
    this.place(vm.cursor.x + 0.5, vm.cursor.renderY, 0.3);
    this.cursor.position.copy(this.pos);
    this.cursor.visible = !vm.hud.lost;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Match the renderer + camera to a new viewport size. */
  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}

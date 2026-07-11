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
  DataTexture,
  DirectionalLight,
  DoubleSide,
  Fog,
  type IUniform,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  Scene,
  type Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BR_DIRECTION_1,
  BR_DIRECTION_2,
  BR_DIRECTION_4,
  GC_BLOCK_STORE_SIZE,
  GC_GARBAGE_STORE_SIZE,
  GC_PLAY_WIDTH,
} from '@crack-attack/core';
import type { BoardViewModel } from '../view/boardViewModel.js';
import { dyingPose } from '../view/dyingAnim.js';
import { blockColor, garbageColor } from './palette.js';
import { swapperCursorGeometry } from './cursorGeometry.js';

const CELL = 1;
const BLOCK_SIZE = 0.92;
/** Radius the key light orbits the board at (only its *direction* matters). */
const KEY_LIGHT_RADIUS = 16;

/**
 * Live-tunable render parameters, driven by the temporary render tuner overlay
 * (`render/renderTuner.ts`). The key light is described as an angle — azimuth
 * (0 = along the view axis, + = to the right) and elevation (0 = horizon,
 * 90 = straight overhead) — which is far easier to dial than a raw xyz.
 */
export interface RenderTuning {
  ambient: number;
  keyIntensity: number;
  keyAzimuthDeg: number;
  keyElevationDeg: number;
  fillIntensity: number;
  shininess: number;
  /** Block specular level, 0–255 gray. */
  specular: number;
  garbageRoughness: number;
  /** Flat-shade the blocks (crisp per-facet edges) instead of smooth normals. */
  flatShading: boolean;
}

// Faithful to the reference block material (`DrawBlocks.cxx`): black material
// ambient (→ near-zero AmbientLight so the diffuse falloff across the pyramid
// facets stays high-contrast), a gray specular (`GL_SPECULAR` 0.5 → 128), and a
// broad `GL_SHININESS` 10. The key light is the "headlight" a bit above the view.
export const DEFAULT_RENDER_TUNING: RenderTuning = {
  ambient: 0.9,
  keyIntensity: 1.15,
  keyAzimuthDeg: 45,
  keyElevationDeg: 22,
  fillIntensity: 0,
  shininess: 10,
  specular: 185,
  garbageRoughness: 0.4,
  flatShading: false,
};

export class BoardView {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;

  private readonly blocks: InstancedMesh;
  private readonly garbage: InstancedMesh;
  private readonly cursor: Mesh;

  // Lights + tunable materials, kept as fields so the temporary render tuner can
  // adjust them live (see `applyRenderTuning`).
  private readonly ambientLight: AmbientLight;
  private readonly keyLight: DirectionalLight;
  private readonly fillLight: DirectionalLight;
  private readonly blockMaterial: MeshPhongMaterial;
  private readonly garbageMaterial: MeshStandardMaterial;

  private readonly halfW: number;
  private readonly halfH: number;
  /**
   * The play-floor clip plane. Faithful to the original's
   * `GL_CLIP_PLANE_PLAY_FLOOR`: it hides everything below the boundary between the
   * incoming creep row (grid row 0) and the lowest playable row (row 1), so the
   * dim creep row rises up into view from off-screen as the board creeps, rather
   * than sitting fully visible at the bottom. Applied to the block + garbage
   * materials only (the back wall and cursor are unclipped).
   */
  private readonly floorPlane: Plane;

  // Scratch objects reused every frame (no per-frame allocation).
  private readonly m = new Matrix4();
  private readonly pos = new Vector3();
  private readonly scl = new Vector3();
  private readonly rot = new Quaternion();
  private readonly color = new Color();
  // A tumble axis for the pop animation, and the colour it flashes toward.
  private readonly spinAxis = new Vector3(0.35, 1, 0.15).normalize();
  private readonly flash = new Color(0xffffff);
  // Scratch for the revolving-door swap: the Y pivot axis and the block's offset
  // from the shared edge it swings around.
  private readonly yAxis = new Vector3(0, 1, 0);
  private readonly swapOffset = new Vector3();
  // Scratch for the awaking pop tumble: the X tumble axis and a spare quaternion.
  private readonly xAxis = new Vector3(1, 0, 0);
  private readonly qTmp = new Quaternion();
  // Garbage lightmap uniform, shared with the patched garbage shader. Starts as
  // a 1×1 white texture (no modulation) and is swapped for the real mottled map
  // once it loads. Kept as a stable object so updating `.value` reaches the
  // already-compiled program without a recompile.
  private readonly lightmap: IUniform<Texture>;

  constructor(container: HTMLElement, width: number, visibleHeight: number) {
    this.halfW = (width - 1) / 2;
    this.halfH = (visibleHeight - 1) / 2;

    // Floor sits at the cell boundary between row 0 (creep) and row 1 (playable):
    // row r maps to world y = r - halfH, so the boundary is at 0.5 - halfH. Keep
    // fragments with y ≥ floorY, i.e. `y*1 + (-floorY) ≥ 0` → Plane((0,1,0), -floorY).
    const floorY = 0.5 - this.halfH;
    this.floorPlane = new Plane(new Vector3(0, 1, 0), -floorY);

    this.scene.background = new Color(0x0b0d12);
    this.scene.fog = new Fog(0x0b0d12, 22, 40);

    this.camera = new PerspectiveCamera(48, 1, 0.1, 100);
    this.camera.position.set(0, 0.5, Math.max(14, visibleHeight * 1.5));
    this.camera.lookAt(0, 0, 0);

    // Lighting: an ambient lift, a key "headlight" that comes from above and to
    // the side (so the block's beveled facets shade directionally and the glossy
    // gleam sits toward the top — the original's angled look, not a head-on
    // hotspot), and a dim opposite fill. Their intensities and the key direction
    // are the single source of truth in DEFAULT_RENDER_TUNING and are set by
    // `applyRenderTuning` at the end of the constructor; only the fill's fixed
    // *position* is set here (it isn't tunable).
    this.ambientLight = new AmbientLight(0xffffff);
    this.scene.add(this.ambientLight);
    this.keyLight = new DirectionalLight(0xffffff);
    this.scene.add(this.keyLight);
    this.fillLight = new DirectionalLight(0xffffff);
    this.fillLight.position.set(-6, 2, 6);
    this.scene.add(this.fillLight);

    // A subtle back wall behind the play area for depth.
    const wall = new Mesh(
      new PlaneGeometry(width + 4, visibleHeight + 4),
      new MeshStandardMaterial({ color: 0x141821, roughness: 1 }),
    );
    wall.position.set(0, 0, -0.8);
    this.scene.add(wall);

    // Per-instance colours come from `InstancedMesh.setColorAt` (→ instanceColor).
    // Three enables the `USE_INSTANCING_COLOR` shader path automatically when an
    // instanceColor attribute is present — no `vertexColors: true` needed (that
    // flag is for per-*vertex* colours, a different attribute).
    // Glossy plastic look faithful to the reference block material: instanceColor
    // drives the diffuse; the gray specular highlight and its falloff (`GL_SPECULAR`
    // / `GL_SHININESS`) come from DEFAULT_RENDER_TUNING via `applyRenderTuning`.
    this.blockMaterial = new MeshPhongMaterial({ clippingPlanes: [this.floorPlane] });
    this.blocks = new InstancedMesh(
      new BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE),
      this.blockMaterial,
      GC_BLOCK_STORE_SIZE,
    );
    this.blocks.count = 0;
    this.scene.add(this.blocks);

    // Garbage renders as one solid slab per piece (a plain box, below) — it keeps
    // its own material and box geometry; the loaded glTF block model is swapped
    // into the *block* mesh only, not this one.
    const white = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
    this.lightmap = { value: white };
    // roughness comes from DEFAULT_RENDER_TUNING via `applyRenderTuning` (a little
    // sheen so slabs catch the headlight like the blocks).
    this.garbageMaterial = new MeshStandardMaterial({
      metalness: 0.0,
      clippingPlanes: [this.floorPlane],
    });
    const garbageMaterial = this.garbageMaterial;
    this.patchGarbageLightmap(garbageMaterial);
    // Garbage is a single solid slab per piece (a unit cube scaled to the slab's
    // width × height), not one cube per cell — the original draws it as a smooth
    // bar with a flat surface, distinct from the faceted blocks.
    this.garbage = new InstancedMesh(
      new BoxGeometry(CELL, CELL, CELL),
      garbageMaterial,
      GC_GARBAGE_STORE_SIZE,
    );
    this.garbage.count = 0;
    this.scene.add(this.garbage);

    // Swap cursor: the reference's four beveled corner brackets (obj_swapper),
    // white and lit by the headlight, always drawn on top of the blocks (a
    // reticle overlays). depthTest off + a high renderOrder keeps it visible.
    this.cursor = new Mesh(
      swapperCursorGeometry(),
      new MeshPhongMaterial({
        color: 0xffffff,
        specular: new Color(0.5, 0.5, 0.5),
        shininess: 12,
        side: DoubleSide,
        depthTest: false,
      }),
    );
    this.cursor.renderOrder = 5; // above the level-light arrows (4)
    this.scene.add(this.cursor);

    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    // Honour per-material clippingPlanes (the play floor) without clipping the
    // whole scene — the back wall and cursor must stay whole.
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    // Upgrade the block geometry from the fallback cube to the real rounded-cube
    // model (converted by tools/obj2gltf). Async; blocks render as boxes until it
    // arrives, and stay boxes if the fetch fails.
    void this.loadBlockModel();
    // Load the mottled garbage lightmap; garbage stays flat-tinted until it lands.
    void this.loadGarbageLightmap();

    // Establish the lighting/material defaults from one source of truth so the
    // render tuner's sliders and the live scene start in agreement.
    this.applyRenderTuning(DEFAULT_RENDER_TUNING);
  }

  /**
   * Apply live render tuning (lights + block/garbage material). Temporary — used
   * by the render tuner overlay to dial in the look; the winning values get
   * baked back into the defaults above.
   */
  applyRenderTuning(t: RenderTuning): void {
    this.ambientLight.intensity = t.ambient;
    this.keyLight.intensity = t.keyIntensity;
    const az = (t.keyAzimuthDeg * Math.PI) / 180;
    const el = (t.keyElevationDeg * Math.PI) / 180;
    this.keyLight.position.set(
      KEY_LIGHT_RADIUS * Math.sin(az) * Math.cos(el),
      KEY_LIGHT_RADIUS * Math.sin(el),
      KEY_LIGHT_RADIUS * Math.cos(az) * Math.cos(el),
    );
    this.fillLight.intensity = t.fillIntensity;
    this.blockMaterial.shininess = t.shininess;
    const g = Math.max(0, Math.min(1, t.specular / 255));
    this.blockMaterial.specular.setRGB(g, g, g);
    // flatShading changes the compiled shader, so only recompile when it flips.
    if (this.blockMaterial.flatShading !== t.flatShading) {
      this.blockMaterial.flatShading = t.flatShading;
      this.blockMaterial.needsUpdate = true;
    }
    this.garbageMaterial.roughness = t.garbageRoughness;
  }

  /**
   * Fetch the glTF block model and swap its geometry into the block instances.
   * The per-instance colours (instanceColor) and material are unaffected — only
   * the shape changes. Normalizes the model to `BLOCK_SIZE` and centres it. The
   * garbage mesh keeps its plain box (it renders as a smooth solid slab, not the
   * faceted block shape).
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

      const oldBlocks = this.blocks.geometry;
      this.blocks.geometry = geom;
      oldBlocks.dispose();
    } catch {
      // Keep the box fallback; the model is a visual upgrade, not required.
    }
  }

  /**
   * Patch the garbage material to modulate its albedo by a world-position-tied
   * lightmap, reproducing `DrawGarbage.cxx`: the mottled luminance map is sampled
   * at `worldXY * conv + 0.5` (one tile spans the board width), so the sheen flows
   * continuously across every cell of a slab — and across slabs sharing a column —
   * rather than tiling per cube. The map is pre-remapped to [0.85, 1.0] luminance
   * when baked, so the shader just multiplies. Blocks are left untouched (only
   * *special* blocks are lightmapped in the original, via a separate 1-D map).
   */
  private patchGarbageLightmap(material: MeshStandardMaterial): void {
    const conv = -1 / GC_PLAY_WIDTH; // DC_GARBAGE_LIGHTMAP_COORD_CONVERTER in cell units
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uLightmap = this.lightmap;
      shader.uniforms.uLmConv = { value: conv };
      shader.vertexShader =
        'varying vec2 vLmUv;\nuniform float uLmConv;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          '#include <project_vertex>\n' +
            '  vec4 lmWorld = modelMatrix * instanceMatrix * vec4(transformed, 1.0);\n' +
            '  vLmUv = lmWorld.xy * uLmConv + 0.5;',
        );
      shader.fragmentShader =
        'varying vec2 vLmUv;\nuniform sampler2D uLightmap;\n' +
        shader.fragmentShader.replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n  diffuseColor.rgb *= texture2D(uLightmap, vLmUv).r;',
        );
    };
  }

  /**
   * Fetch the baked garbage lightmap and hand it to the patched shader by swapping
   * the shared uniform's `.value` (no material recompile). Tiles (RepeatWrapping)
   * for boards taller/wider than one map. Stays the white no-op texture on failure.
   */
  private async loadGarbageLightmap(): Promise<void> {
    try {
      const url = new URL('textures/garbage_lightmap.png', document.baseURI).href;
      const tex = await new TextureLoader().loadAsync(url);
      tex.wrapS = RepeatWrapping;
      tex.wrapT = RepeatWrapping;
      const previous = this.lightmap.value;
      this.lightmap.value = tex;
      previous.dispose();
    } catch {
      // Keep the flat white lightmap; the sheen is a visual upgrade, not required.
    }
  }

  /** World position for a cell (writes into `this.pos`). */
  private place(x: number, y: number, z = 0): Vector3 {
    return this.pos.set(x - this.halfW, y - this.halfH, z);
  }

  /**
   * Vertical shake offset in cell units (the Spring's output). Applied to the
   * whole scene, so blocks, garbage, signs, and lights dip together — faithful
   * to the reference applying Spring::y to the board translation
   * (Displayer.cxx:638).
   */
  setShake(offsetCells: number): void {
    this.scene.position.y = offsetCells;
  }

  /** Mirror `vm` onto the meshes. Call once per rendered frame. */
  update(vm: BoardViewModel): void {
    // Blocks.
    let i = 0;
    for (const b of vm.blocks) {
      this.place(b.x, b.renderY);
      this.color.copy(blockColor(b.flavor));

      if (b.phase === 'dying') {
        // Two-phase pop, faithful to DrawBlocks.cxx:318-360: first a full-size
        // double white strobe (DC_DYING_FLASH_TIME), then a quadratically
        // accelerating tumble while shrinking to DC_DYING_SHRINK_MIN_SIZE.
        const pose = dyingPose(b.deathProgress);
        this.scl.setScalar(pose.scale);
        this.rot.setFromAxisAngle(this.spinAxis, pose.angle);
        this.color.lerp(this.flash, pose.flash);
      } else if (b.phase === 'swapping') {
        // Revolving door: the block swings a semicircle around the vertical edge
        // it shares with its swap partner (faithful to the swap_factor transform
        // in DrawBlocks.cxx). `dir` is +1 moving right, -1 left; the pivot is that
        // shared edge and the block starts half a cell to its origin side. Both
        // partners spin the *same* direction (θ 0→180°) so they pass on opposite
        // sides of the edge (one bulges toward the camera, the other away) instead
        // of overlapping at the midpoint.
        const dir = b.swapRight ? 1 : -1;
        const theta = Math.PI * b.swapFactor;
        this.scl.setScalar(1);
        this.rot.setFromAxisAngle(this.yAxis, theta);
        this.place(b.x + dir * 0.5, b.renderY); // pivot on the shared edge
        this.swapOffset.set(-dir * 0.5, 0, 0).applyAxisAngle(this.yAxis, theta);
        this.pos.add(this.swapOffset);
      } else if (b.phase === 'awaking' && b.awakeProgress < 1) {
        // Pop-in: a shattered-garbage cell wakes as a small garbage-coloured cube,
        // then grows (0.5→1), tumbles into alignment, and shifts to its block
        // colour as it pops — staggered per block by its pop delay (faithful to
        // the BS_AWAKING branch of DrawBlocks.cxx, minus the reference's hard
        // end-of-pop rotation snap so the tumble resolves smoothly to identity).
        const progress = b.awakeProgress;
        const p = 1 - progress; // 1 dormant → 0 popped
        this.scl.setScalar(0.5 + 0.5 * progress);
        const a = p * (Math.PI / 4); // ≤45° tumble, → 0 as it finishes
        const signX = b.popDirection & (BR_DIRECTION_1 | BR_DIRECTION_4) ? 1 : -1;
        const signY = b.popDirection & (BR_DIRECTION_1 | BR_DIRECTION_2) ? 1 : -1;
        this.rot.setFromAxisAngle(this.xAxis, signX * a);
        this.qTmp.setFromAxisAngle(this.yAxis, signY * a);
        this.rot.multiply(this.qTmp);
        // Colour eases from the garbage flavour it shattered from to the block flavour.
        this.color.lerp(garbageColor(b.popColor), p);
      } else {
        this.scl.setScalar(1);
        this.rot.identity();
        // Dim the incoming creep row (`creep_colors` are 0.25× in the original) so
        // it reads as "not yet in play": it rises up dim from below the play floor
        // and snaps to full brightness when the grid shift promotes it to row 1.
        if (b.preview) this.color.multiplyScalar(0.25);
      }

      this.m.compose(this.pos, this.rot, this.scl);
      this.blocks.setMatrixAt(i, this.m);
      this.blocks.setColorAt(i, this.color);
      i++;
    }
    this.blocks.count = i;
    this.blocks.instanceMatrix.needsUpdate = true;
    if (this.blocks.instanceColor) this.blocks.instanceColor.needsUpdate = true;

    // Garbage: one solid slab per piece — a unit cube scaled to the slab's
    // width × height (a slight inset leaves a seam between neighbours). The block
    // loop leaves `this.rot` set to a dying block's tumble, so reset it to identity
    // before composing the axis-aligned slab transforms.
    this.rot.identity();
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

  /**
   * Release the WebGL context and detach the canvas. For mode switches
   * (solo ↔ netplay): browsers cap live WebGL contexts, so views must not
   * simply be dropped on the floor.
   */
  dispose(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

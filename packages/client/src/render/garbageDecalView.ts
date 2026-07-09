/**
 * garbageDecalView.ts — draws the decorative garbage flavor image.
 *
 * A thin Three.js layer over {@link garbageDecal}: one textured quad that sits on
 * the face of a single large garbage slab, faithful to the original's one-at-a-
 * time `GarbageFlavorImage`. When the decal is free it evaluates each newly seen
 * eligible slab once (claiming ~7 in 8), picks one of the four images and an
 * interior anchor, and then rides that slab until it leaves the board.
 *
 * Cosmetic: it reads the interpolated garbage sprites each frame and draws on
 * `Math.random`, never the deterministic core.
 */

import {
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type Scene,
  type Texture,
  TextureLoader,
} from 'three';
import type { GarbageSprite } from '../view/boardViewModel.js';
import { decalAnchor, decalClaims, decalEligible, pickDecalTexture } from '../view/garbageDecal.js';

/** The decal covers a 2×2-cell patch (the square source art, undistorted). */
const DECAL_SIZE = 2;

interface DecalOwner {
  key: string;
  texIndex: number;
  dx: number;
  dy: number;
}

const spriteKey = (g: GarbageSprite): string => `${g.id}:${g.generation}`;

export class GarbageDecalView {
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly loader = new TextureLoader();
  private readonly cache = new Map<number, Texture | undefined>();
  /** Which slab (if any) currently wears the decal, and how. */
  private owner: DecalOwner | null = null;
  /** Slabs already evaluated for a decal (so each rolls only once, on appearance). */
  private evaluated = new Set<string>();

  constructor(
    scene: Scene,
    private readonly halfW: number,
    private readonly halfH: number,
    private readonly rand: () => number = Math.random,
  ) {
    this.material = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 1,
    });
    this.mesh = new Mesh(new PlaneGeometry(DECAL_SIZE, DECAL_SIZE), this.material);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5; // over the garbage cubes, under the reward signs
    scene.add(this.mesh);
  }

  /** Update the decal against this frame's garbage slabs. */
  update(garbage: readonly GarbageSprite[]): void {
    const present = new Set<string>();
    for (const g of garbage) present.add(spriteKey(g));

    // Forget slabs that have left the board (bounds the evaluated set; frees the
    // decal when its wearer is gone).
    for (const key of this.evaluated) if (!present.has(key)) this.evaluated.delete(key);
    if (this.owner && !present.has(this.owner.key)) this.owner = null;

    // If the decal is free, let each not-yet-seen eligible slab roll once.
    if (!this.owner) {
      for (const g of garbage) {
        const key = spriteKey(g);
        if (this.evaluated.has(key) || !decalEligible(g.width, g.height)) continue;
        this.evaluated.add(key);
        if (decalClaims(this.rand)) {
          const texIndex = pickDecalTexture(this.rand);
          const { dx, dy } = decalAnchor(g.width, g.height, this.rand);
          this.owner = { key, texIndex, dx, dy };
          this.ensureTexture(texIndex);
          break;
        }
      }
    }

    // Position the decal on its slab, if it has a claimed one that's loaded.
    if (!this.owner) {
      this.mesh.visible = false;
      return;
    }
    const slab = garbage.find((g) => spriteKey(g) === this.owner!.key);
    const tex = this.cache.get(this.owner.texIndex);
    if (!slab || !tex) {
      this.mesh.visible = false;
      return;
    }
    this.material.map = tex;
    this.material.needsUpdate = true;
    // Centre the 2×2 decal over cells [dx, dx+1] × [dy, dy+1] of the slab.
    const cx = slab.x + this.owner.dx + 0.5 - this.halfW;
    const cy = slab.renderY + this.owner.dy + 0.5 - this.halfH;
    this.mesh.position.set(cx, cy, 0.55); // just in front of the cube faces
    this.mesh.visible = true;
  }

  /** Drop the current decal (e.g. on restart). */
  clear(): void {
    this.owner = null;
    this.evaluated.clear();
    this.mesh.visible = false;
  }

  /** Lazily load and cache a decal image by index. */
  private ensureTexture(index: number): void {
    if (this.cache.has(index)) return;
    this.cache.set(index, undefined); // reserve so we don't double-load
    const key = `garbage_flavor_${String(index).padStart(3, '0')}`;
    const url = new URL(`textures/garbage/${key}.png`, document.baseURI).href;
    this.loader.load(
      url,
      (tex) => this.cache.set(index, tex),
      undefined,
      () => {
        // Load failed: forget the entry so a later spawn can retry, and release
        // the decal if this was the image it was waiting on — otherwise the owner
        // would stay pinned to a slab that can never render, blocking every other
        // slab from ever claiming the decal until it leaves the board.
        this.cache.delete(index);
        if (this.owner?.texIndex === index) this.owner = null;
      },
    );
  }
}

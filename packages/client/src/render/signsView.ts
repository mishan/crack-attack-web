/**
 * signsView.ts — draws the floating combo reward signs.
 *
 * A thin Three.js layer over the pure {@link signs} model: it keeps a small pool
 * of camera-facing sprites, spawns one per {@link SignEvent} the sim reports, and
 * each frame advances their shared life (hold → fade + inflate + float) and
 * mirrors the result onto the sprites. Sign textures are the converted originals
 * (`textures/signs/sign_*.png`), white glyphs on transparent tinted per kind.
 *
 * Signs are cosmetic, so they animate on wall-clock time (passed in as ticks) and
 * never touch the deterministic core beyond draining its event queue.
 */

import { Group, type Scene, Sprite, SpriteMaterial, type Texture, TextureLoader } from 'three';
import type { SignKind } from '@crack-attack/core';
import {
  SIGN_LIFE_TIME,
  signAlpha,
  signColor,
  signExpired,
  signRiseDelta,
  signScale,
  signTextureKey,
} from '../view/signs.js';

/** Matches the original's `DC_MAX_SIGN_NUMBER`. */
const SIGN_POOL_SIZE = 25;
/** On-screen height of a sign at unit scale, in world cells. */
const SIGN_BASE_SIZE = 0.8;
/** Placement nudge from the kernel cell (`DC_SIGN_OFFSET_*`, in unit cells). */
const OFFSET_X = -0.25;
const OFFSET_Y = 0.25;
const OFFSET_SPREAD = 0.05;

interface ActiveSign {
  worldX: number;
  worldY: number;
  life: number;
  key: string;
  colorHex: number;
}

export class SignsView {
  private readonly group = new Group();
  private readonly sprites: Sprite[] = [];
  private readonly active: ActiveSign[] = [];
  private readonly loader = new TextureLoader();
  /**
   * Cached sign textures + their aspect ratio (w/h), keyed by basename. `tex` is
   * `null` while a load is in flight (the sprite stays hidden until it arrives).
   */
  private readonly cache = new Map<string, { tex: Texture | null; aspect: number }>();

  constructor(
    scene: Scene,
    private readonly halfW: number,
    private readonly halfH: number,
  ) {
    this.group.renderOrder = 10; // draw over the board
    for (let i = 0; i < SIGN_POOL_SIZE; i++) {
      const mat = new SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false });
      const sprite = new Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = 10;
      this.sprites.push(sprite);
      this.group.add(sprite);
    }
    scene.add(this.group);
  }

  /** Spawn a reward sign for a core {@link SignEvent} at grid cell (gridX, gridY). */
  spawn(gridX: number, gridY: number, kind: SignKind, level: number): void {
    // Multiplier signs sit up-and-right of the kernel in the original; nudge to match.
    const cellX = kind === 'multiplier' ? gridX + 1 : gridX;
    const cellY = kind === 'multiplier' ? gridY - 1 : gridY;
    const jitterX = (Math.random() * 2 - 1) * OFFSET_SPREAD;
    const jitterY = (Math.random() * 2 - 1) * OFFSET_SPREAD;
    const sign: ActiveSign = {
      worldX: cellX - this.halfW + OFFSET_X + jitterX,
      worldY: cellY - this.halfH + OFFSET_Y + jitterY,
      life: 0,
      key: signTextureKey(kind, level),
      colorHex: signColor(kind, level),
    };
    if (this.active.length >= SIGN_POOL_SIZE) this.active.shift(); // drop the oldest
    this.active.push(sign);
    this.ensureTexture(sign.key);
  }

  /** Advance every active sign by `dtTicks` (50 Hz sim ticks; may be fractional). */
  update(dtTicks: number): void {
    if (dtTicks > 0) {
      for (const s of this.active) {
        s.worldY += signRiseDelta(s.life) * dtTicks;
        s.life += dtTicks;
      }
      // Drop expired signs (compact in place, preserving order).
      let w = 0;
      for (let r = 0; r < this.active.length; r++) {
        if (!signExpired(this.active[r]!.life)) this.active[w++] = this.active[r]!;
      }
      this.active.length = w;
    }

    // Mirror active signs onto the sprite pool; hide the rest.
    for (let i = 0; i < this.sprites.length; i++) {
      const sprite = this.sprites[i]!;
      const s = this.active[i];
      if (!s) {
        sprite.visible = false;
        continue;
      }
      const entry = this.cache.get(s.key);
      const mat = sprite.material as SpriteMaterial;
      const nextMap = entry?.tex ?? null;
      // Only `needsUpdate` when the *map* changes — swapping a texture (or
      // null↔texture) alters the shader defines, but opacity/colour don't and
      // toggling it every frame forces needless program-cache churn in Three.
      if (mat.map !== nextMap) {
        mat.map = nextMap;
        mat.needsUpdate = true;
      }
      mat.color.setHex(s.colorHex);
      mat.opacity = signAlpha(s.life);
      const scale = signScale(s.life) * SIGN_BASE_SIZE;
      const aspect = entry?.aspect ?? 1.5;
      sprite.scale.set(scale * aspect, scale, 1);
      sprite.position.set(s.worldX, s.worldY, 0.5);
      sprite.visible = mat.map !== null && mat.opacity > 0;
    }
  }

  /** Remove all active signs (e.g. on restart). */
  clear(): void {
    this.active.length = 0;
    for (const sprite of this.sprites) sprite.visible = false;
  }

  /** Lazily load and cache a sign texture (with its aspect ratio for scaling). */
  private ensureTexture(key: string): void {
    if (this.cache.has(key)) return;
    // Reserve the slot with a null texture so we don't kick off duplicate loads
    // and the sprite stays hidden until the real texture arrives.
    this.cache.set(key, { tex: null, aspect: 1.5 });
    const url = new URL(`textures/signs/${key}.png`, document.baseURI).href;
    this.loader.load(
      url,
      (tex) => {
        const img = tex.image as { width?: number; height?: number } | undefined;
        const aspect = img?.width && img?.height ? img.width / img.height : 1.5;
        this.cache.set(key, { tex, aspect });
      },
      undefined,
      () => this.cache.delete(key), // let a later spawn retry on failure
    );
  }

  /** Longest a spawned sign can remain visible, in ticks (for callers/tests). */
  get maxLifeTicks(): number {
    return SIGN_LIFE_TIME;
  }
}

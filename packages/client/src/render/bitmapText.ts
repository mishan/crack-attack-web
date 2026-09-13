/**
 * bitmapText.ts — draws the original glyph fonts as tinted canvas labels.
 *
 * The DOM layer over the pure `view/bitmapFont.ts` metrics: it loads a glyph
 * atlas once (`public/textures/font/{font0,clock}.png` — white-on-alpha masks
 * converted from the reference TGAs), composites a string onto a `<canvas>`
 * using {@link layout}, and tints it. A {@link BitmapLabel} owns one canvas and
 * a `setText`; before the atlas has loaded it shows the plain text as a
 * fallback, then swaps to the rendered glyphs. This replaces the DOM-text clock,
 * score, and names with the retro bitmap look (PARITY item 14).
 */

import { GLYPH_CELL, type Font, type Placement, layout } from '../view/bitmapFont.js';

/** Cache of atlas-image load promises, keyed by atlas basename. */
const atlasCache = new Map<string, Promise<HTMLImageElement>>();

function loadAtlas(name: string): Promise<HTMLImageElement> {
  let p = atlasCache.get(name);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = (): void => resolve(img);
      img.onerror = reject;
      img.src = new URL(`textures/font/${name}.png`, document.baseURI).href;
    });
    // Don't cache a transient failure permanently: evict on rejection so a later
    // label can retry the load (a brief offline/cache hiccup shouldn't blank the
    // font until a full page reload).
    p.catch(() => atlasCache.delete(name));
    atlasCache.set(name, p);
  }
  return p;
}

export interface BitmapLabelOptions {
  /** Rendered glyph height in CSS px (the atlas cell is scaled to this). */
  height?: number;
  /** Tint colour for the glyphs (CSS colour). */
  color?: string;
  /**
   * Shade each glyph with the reference clock digits' blue-to-white diagonal
   * (`Displayer::drawDigit`'s vertex colours) instead of a flat `color`.
   */
  shaded?: boolean;
}

/**
 * A single line of bitmap text. Mount {@link element} in the DOM and call
 * {@link setText}. Rendering is cheap (one canvas blit per glyph) and only
 * happens when the text actually changes.
 */
export class BitmapLabel {
  /** The mountable element: the canvas once the atlas loads, a text span until then. */
  readonly element: HTMLElement;

  private readonly canvas: HTMLCanvasElement;
  private readonly fallback: HTMLElement;
  private atlas: HTMLImageElement | null = null;
  private text = '';
  private readonly height: number;
  private readonly color: string;
  private readonly shaded: boolean;
  /** One glyph cell, for shading glyphs one at a time (created on first use). */
  private scratch: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;

  constructor(
    private readonly font: Font,
    opts: BitmapLabelOptions = {},
  ) {
    this.height = opts.height ?? 22;
    this.color = opts.color ?? '#d7dce5';
    this.shaded = opts.shaded ?? false;

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'none';
    this.canvas.style.height = `${this.height}px`;
    this.canvas.style.imageRendering = 'auto';
    // The canvas has no intrinsic text, so expose the string to assistive tech.
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '');

    // Plain-text stand-in until the atlas is ready (also the graceful fallback
    // if the atlas fails to load).
    this.fallback = document.createElement('span');
    this.fallback.style.fontVariantNumeric = 'tabular-nums';

    const wrap = document.createElement('span');
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    // The same height before and after the atlas loads (and with no text yet),
    // so layout measured early — the boards frame around the HUD — holds.
    wrap.style.height = `${this.height}px`;
    wrap.append(this.canvas, this.fallback);
    this.element = wrap;

    loadAtlas(this.font.atlas)
      .then((img) => {
        this.atlas = img;
        this.render();
      })
      .catch(() => {
        // Atlas failed to load (missing asset / offline): keep the plain-text
        // fallback rather than surfacing an unhandled rejection.
      });
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.render();
  }

  private render(): void {
    // Keep the accessible name in sync whichever branch renders.
    this.canvas.setAttribute('aria-label', this.text);
    if (!this.atlas) {
      this.fallback.textContent = this.text;
      return;
    }
    const scale = this.height / GLYPH_CELL;
    const { glyphs, extent } = layout(this.text, this.font);
    const dpr = globalThis.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.ceil(extent * scale));
    this.canvas.width = Math.ceil(cssW * dpr);
    this.canvas.height = Math.ceil(this.height * dpr);
    this.canvas.style.width = `${cssW}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // Keep the pixel-art glyphs crisp — no smoothing when the 32px cells scale
    // to the label height (especially non-integer / high-DPI scales).
    ctx.imageSmoothingEnabled = false;
    if (this.shaded) {
      for (const g of glyphs) this.drawShaded(ctx, g, dpr * scale);
    } else {
      ctx.scale(dpr * scale, dpr * scale);
      const cell = this.font.cell;
      for (const g of glyphs) {
        ctx.drawImage(this.atlas, g.index * cell, 0, cell, cell, g.x, 0, cell, cell);
      }
      // Tint: the atlas is white-on-alpha, so paint the colour through the alpha.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = this.color;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }

    this.canvas.style.display = 'inline-block';
    this.fallback.style.display = 'none';
  }

  /**
   * Draw one glyph (at `px` device px per glyph px) shaded as the reference
   * draws each clock digit on its own quad: (0.3, 0.3, 1) at the bottom-left,
   * (0.5, 0.5, 1) at the other two corners, white at the top-right — linear
   * along that diagonal. Shaded in a scratch cell so overlapping neighbours
   * keep their own gradients.
   */
  private drawShaded(ctx: CanvasRenderingContext2D, g: Placement, px: number): void {
    const f = this.font.cell;
    const size = Math.ceil(f * px);
    const c = this.shadeCell(size);
    if (!c || !this.atlas || !this.scratch) return;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, size, size);
    c.drawImage(this.atlas, g.index * f, 0, f, f, 0, 0, size, size);
    c.globalCompositeOperation = 'source-in';
    c.fillRect(0, 0, size, size); // fillStyle is the gradient (shadeCell)
    ctx.drawImage(this.scratch, Math.round(g.x * px), 0);
  }

  /**
   * The scratch cell's context, sized to `size` device px with the shading
   * gradient as its fill. Resized (and the gradient rebuilt) only when the size
   * changes, so redrawing a label doesn't reallocate per glyph.
   */
  private shadeCell(size: number): CanvasRenderingContext2D | null {
    if (this.scratch?.width === size) return this.scratchCtx;
    this.scratch ??= document.createElement('canvas');
    this.scratch.width = size; // resets the context state, so set it up again
    this.scratch.height = size;
    this.scratchCtx = this.scratch.getContext('2d');
    if (this.scratchCtx) {
      this.scratchCtx.imageSmoothingEnabled = false;
      const shade = this.scratchCtx.createLinearGradient(0, size, size, 0);
      shade.addColorStop(0, 'rgb(77, 77, 255)');
      shade.addColorStop(0.5, 'rgb(128, 128, 255)');
      shade.addColorStop(1, 'rgb(255, 255, 255)');
      this.scratchCtx.fillStyle = shade;
    }
    return this.scratchCtx;
  }
}

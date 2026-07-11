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

import { GLYPH_CELL, type Font, layout } from '../view/bitmapFont.js';

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
    atlasCache.set(name, p);
  }
  return p;
}

export interface BitmapLabelOptions {
  /** Rendered glyph height in CSS px (the atlas cell is scaled to this). */
  height?: number;
  /** Tint colour for the glyphs (CSS colour). */
  color?: string;
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

  constructor(
    private readonly font: Font,
    opts: BitmapLabelOptions = {},
  ) {
    this.height = opts.height ?? 22;
    this.color = opts.color ?? '#d7dce5';

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'none';
    this.canvas.style.height = `${this.height}px`;
    this.canvas.style.imageRendering = 'auto';

    // Plain-text stand-in until the atlas is ready (also the graceful fallback
    // if the atlas fails to load).
    this.fallback = document.createElement('span');
    this.fallback.style.fontVariantNumeric = 'tabular-nums';

    const wrap = document.createElement('span');
    wrap.style.display = 'inline-flex';
    wrap.style.alignItems = 'center';
    wrap.append(this.canvas, this.fallback);
    this.element = wrap;

    void loadAtlas(this.font.atlas).then((img) => {
      this.atlas = img;
      this.render();
    });
  }

  setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.render();
  }

  private render(): void {
    if (!this.atlas) {
      this.fallback.textContent = this.text;
      return;
    }
    const scale = this.height / GLYPH_CELL;
    const { glyphs, width } = layout(this.text, this.font);
    const dpr = globalThis.devicePixelRatio || 1;
    const cssW = Math.max(1, Math.ceil(width * scale));
    this.canvas.width = Math.ceil(cssW * dpr);
    this.canvas.height = Math.ceil(this.height * dpr);
    this.canvas.style.width = `${cssW}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
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

    this.canvas.style.display = 'inline-block';
    this.fallback.style.display = 'none';
  }
}

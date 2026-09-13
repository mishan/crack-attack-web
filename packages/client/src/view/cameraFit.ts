/**
 * cameraFit.ts — where a board's camera must sit to frame it in its viewport.
 *
 * A `PerspectiveCamera`'s FOV is vertical, so the board's framed height is fixed
 * by the camera distance alone, while the framed width shrinks with the viewport
 * aspect. On a narrow viewport — a portrait phone, or half of one when two boards
 * sit side by side — the board's sides fall out of frame. The fix is to dolly the
 * camera back just far enough to fit the board's width, never closer than its
 * base framing, so wide (desktop) viewports frame exactly as before.
 *
 * Screen chrome (HUD, buttons, on-screen touch controls) can also cover the
 * board. {@link frameBoards} takes the chrome's rectangles and finds the largest
 * board, nearest its centred spot, that none of them covers: it slides sideways
 * where there's room (a landscape phone's corner touch pad), else shrinks and
 * slides vertically (a portrait phone's HUD above and pad below).
 */

/** A screen-space rectangle, in CSS px relative to the board's viewport. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The board's size and the camera's base framing. */
export interface BoardFit {
  /** Camera distance at a wide viewport (the board's base framing). */
  baseDistance: number;
  /** Vertical field of view, in degrees. */
  fovDeg: number;
  /** World units either side of the board centre that must stay in frame. */
  halfExtentX: number;
  halfExtentY: number;
}

/** One board's viewport and the chrome over it, in its own CSS px. */
export interface BoardViewport {
  width: number;
  height: number;
  chrome: readonly Rect[];
}

export interface BoardFrame {
  /** Camera distance from the board. */
  distance: number;
  /**
   * Where the board's extents land in its viewport. The camera slides the image
   * (not itself) to put them there, so the viewing angle never changes.
   */
  rect: Rect;
}

/** The smallest board, relative to its plain framing, worth shrinking to avoid chrome. */
const MIN_SCALE = 0.5;
/** Board sizes tried between the plain framing and MIN_SCALE, largest first. */
const SCALE_STEPS = 25;

/**
 * The camera distance that keeps `halfExtentX` world units either side of the
 * centre in view at `aspect` (width / height), and at least `baseDistance`.
 */
export function fitCameraDistance(
  baseDistance: number,
  fovDeg: number,
  aspect: number,
  halfExtentX: number,
): number {
  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
  const widthFit = halfExtentX / (tanHalfFov * Math.max(aspect, 1e-3));
  return Math.max(baseDistance, widthFit);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Where a span of `size` may start within `[0, limit]`: centred, or flush
 * against one of `edges` — nearest the centre first.
 */
function candidates(size: number, limit: number, edges: readonly number[]): number[] {
  const centre = (limit - size) / 2;
  if (size >= limit) return [centre];
  const clamped = [centre, ...edges].map((p) => Math.min(Math.max(p, 0), limit - size));
  return [...new Set(clamped)].sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
}

/**
 * Frame boards shown together, each clear of the chrome over its viewport.
 * They share one size and vertical position, so side-by-side boards always
 * match; each slides sideways on its own. When no board of at least MIN_SCALE
 * fits clear of the chrome, the boards keep their plain, centred framing.
 */
export function frameBoards(fit: BoardFit, viewports: readonly BoardViewport[]): BoardFrame[] {
  const tanHalfFov = Math.tan((fit.fovDeg * Math.PI) / 360);
  const heightOf = (v: BoardViewport): number => Math.max(1, v.height);
  const plain = Math.max(
    ...viewports.map((v) =>
      fitCameraDistance(fit.baseDistance, fit.fovDeg, v.width / heightOf(v), fit.halfExtentX),
    ),
  );
  const sizeAt = (v: BoardViewport, distance: number): [number, number] => {
    const pxPerUnit = heightOf(v) / (2 * distance * tanHalfFov);
    return [2 * fit.halfExtentX * pxPerUnit, 2 * fit.halfExtentY * pxPerUnit];
  };
  const rectAt = (x: number, y: number, w: number, h: number): Rect => ({
    left: x,
    top: y,
    right: x + w,
    bottom: y + h,
  });

  const placeAll = (distance: number): BoardFrame[] | null => {
    const [, h] = sizeAt(viewports[0]!, distance);
    const allChrome = viewports.flatMap((v) => v.chrome);
    const ys = candidates(
      h,
      heightOf(viewports[0]!),
      allChrome.flatMap((o) => [o.bottom, o.top - h]),
    );
    for (const y of ys) {
      const frames: BoardFrame[] = [];
      for (const v of viewports) {
        const [w, bh] = sizeAt(v, distance);
        const xs = candidates(
          w,
          v.width,
          v.chrome.flatMap((o) => [o.right, o.left - w]),
        );
        const x = xs.find((cx) => !v.chrome.some((o) => overlaps(o, rectAt(cx, y, w, bh))));
        if (x === undefined) break;
        frames.push({ distance, rect: rectAt(x, y, w, bh) });
      }
      if (frames.length === viewports.length) return frames;
    }
    return null;
  };

  for (let i = 0; i <= SCALE_STEPS; i++) {
    const scale = 1 - ((1 - MIN_SCALE) * i) / SCALE_STEPS;
    const frames = placeAll(plain / scale);
    if (frames) return frames;
  }
  return viewports.map((v) => {
    const [w, h] = sizeAt(v, plain);
    return { distance: plain, rect: rectAt((v.width - w) / 2, (heightOf(v) - h) / 2, w, h) };
  });
}

/** {@link frameBoards} for a board shown on its own. */
export function frameBoard(
  fit: BoardFit,
  width: number,
  height: number,
  chrome: readonly Rect[] = [],
): BoardFrame {
  return frameBoards(fit, [{ width, height, chrome }])[0]!;
}

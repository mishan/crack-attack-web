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
 * board. {@link frameBoard} takes the chrome's rectangles and, only when one
 * actually overlaps the framed board, shrinks and slides the board into the
 * band of the viewport the chrome leaves free.
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

export interface BoardFrame {
  /** Camera distance from the board. */
  distance: number;
  /**
   * How far up the board is slid, in px, to centre it in the free band (for
   * `PerspectiveCamera.setViewOffset`; the viewing angle is unchanged).
   */
  shiftPx: number;
  /** Where the board's extents land on screen. */
  rect: Rect;
}

/**
 * Chrome that would leave less than this share of the viewport's height free
 * would shrink the board too far to play, so it's left overlapping instead.
 */
const MIN_FREE_BAND = 0.5;
/** Re-checks after sliding the board, in case it slid into other chrome. */
const MAX_PASSES = 4;

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
 * Frame a board in a `width` × `height` viewport, clear of any `obstacles` that
 * would otherwise cover it. Obstacles in the top half push the board down; those
 * in the bottom half push it up.
 */
export function frameBoard(
  fit: BoardFit,
  width: number,
  height: number,
  obstacles: readonly Rect[] = [],
): BoardFrame {
  const h = Math.max(1, height);
  const tanHalfFov = Math.tan((fit.fovDeg * Math.PI) / 360);
  const place = (distance: number, shiftPx: number): BoardFrame => {
    const pxPerUnit = h / (2 * distance * tanHalfFov);
    const cx = width / 2;
    const cy = h / 2 - shiftPx;
    const rect = {
      left: cx - fit.halfExtentX * pxPerUnit,
      right: cx + fit.halfExtentX * pxPerUnit,
      top: cy - fit.halfExtentY * pxPerUnit,
      bottom: cy + fit.halfExtentY * pxPerUnit,
    };
    return { distance, shiftPx, rect };
  };

  const plain = place(
    fitCameraDistance(fit.baseDistance, fit.fovDeg, width / h, fit.halfExtentX),
    0,
  );
  let frame = plain;
  let topInset = 0;
  let bottomInset = 0;
  const ignored = new Set<Rect>();
  const intrusion = (o: Rect): number => (o.top + o.bottom < h ? o.bottom : h - o.top);
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const hits = obstacles.filter((o) => !ignored.has(o) && overlaps(o, frame.rect));
    if (hits.length === 0) break;
    // Least intrusive first, so small chrome is still avoided when a big piece
    // (landscape touch controls) has to be left overlapping.
    hits.sort((a, b) => intrusion(a) - intrusion(b));
    for (const o of hits) {
      const fromTop = o.top + o.bottom < h;
      const nextTop = fromTop ? Math.max(topInset, o.bottom) : topInset;
      const nextBottom = fromTop ? bottomInset : Math.max(bottomInset, h - o.top);
      if (h - nextTop - nextBottom < h * MIN_FREE_BAND) {
        ignored.add(o);
      } else {
        topInset = nextTop;
        bottomInset = nextBottom;
      }
    }
    const free = h - topInset - bottomInset;
    const heightFit = (fit.halfExtentY * h) / (free * tanHalfFov);
    frame = place(Math.max(plain.distance, heightFit), (bottomInset - topInset) / 2);
  }
  return frame;
}

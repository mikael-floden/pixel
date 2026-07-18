/**
 * Runtime-composed button plates — the SAME philosophy as the page frame
 * (frame2.ts) and exactly what the maintainer asked for: "cut the button in
 * half and use texture from the button to fill it out" + "always use nearest
 * neighbour".
 *
 * CRUCIAL: the plate PNG is NOT full-bleed — the 224² canvas holds the plate
 * floating inside a wide transparent margin (real art at x≈26..197, y≈20..207;
 * TRIM below). Composing the raw 224² quarters floated the rounded corner in
 * the MIDDLE of the button edge with the page gap bleeding through and the
 * outline breaking apart (maintainer marked exactly those corners in red).
 * So we work in the TIGHT plate rect: cut IT down the middle, seat the four
 * corner blocks flush against the canvas edges, and extrude the single plain
 * column/row at the cut across the inserted gap. The black outline now runs
 * straight to the button's real corners — the crisp continuous 1px border the
 * maintainer marked in blue on the frame rail.
 *
 * Composed at 2× the CSS box (DS=2), then the button's
 * `background-size:100% 100%` shows it at ÷2 — a CLEAN integer nearest-
 * neighbour step (image-rendering:pixelated). That puts the plate at 0.5×
 * native, the same scale as the middle-menu tab plates, so the ~2px outline
 * reads as a ~1px CSS border. imageSmoothingEnabled stays off throughout.
 */

export type PlateKind = "normal" | "pressed" | "selected";

const SRC: Record<PlateKind, string> = {
  normal: "/ui2/plate-normal.png",
  pressed: "/ui2/plate-pressed.png",
  selected: "/ui2/plate-selected.png",
};

// Tight opaque bounds of the plate inside its 224² canvas [l, t, r, b] — the
// art has a big transparent margin (measured from the PNGs; normal & pressed
// share these exactly). selected carries a glow out to the full canvas, but
// its plate BODY sits here too and it's unused by the composed buttons
// (settings buttons only ask for normal/pressed), so one rect serves all.
const TRIM: Record<PlateKind, [number, number, number, number]> = {
  normal: [26, 20, 197, 207],
  pressed: [26, 20, 197, 207],
  selected: [26, 20, 197, 207],
};

const DS = 2; // display downscale: compose at NATIVE res then show at ÷2, a
// CLEAN integer (nearest-neighbour) step. Non-integer scales (the old 0.46×
// corner) jaggy the outline + 1px engraved line.

const imgs: Partial<Record<PlateKind, HTMLImageElement>> = {};
const cache = new Map<string, string>();
let readyP: Promise<void> | null = null;

/** Preload the three plate images (idempotent). */
export function readyPlates(): Promise<void> {
  if (!readyP) {
    readyP = Promise.all(
      (Object.keys(SRC) as PlateKind[]).map(
        (k) =>
          new Promise<void>((res, rej) => {
            const im = new Image();
            im.onload = () => {
              imgs[k] = im;
              res();
            };
            im.onerror = rej;
            im.src = SRC[k];
          }),
      ),
    ).then(() => {});
  }
  return readyP;
}

/** A data-URL plate composed at NATIVE plate resolution (×DS the CSS box) so
 * the button's `background-size:100% 100%` shows it at a clean integer ÷DS.
 * null until the art has loaded — callers re-run after readyPlates(). */
export function plateUrl(kind: PlateKind, w: number, h: number): string | null {
  const img = imgs[kind];
  if (!img) return null;
  const [tl, tt, tr, tb] = TRIM[kind];
  const pw = tr - tl; // tight plate width  (source px)
  const ph = tb - tt; // tight plate height (source px)
  const hx = tl + (pw >> 1); // cut column: the plate's own centre
  const hy = tt + (ph >> 1); // cut row
  const lw = hx - tl; // left / right half widths (sum = pw)
  const rw = tr - hx;
  const th = hy - tt; // top / bottom half heights (sum = ph)
  const bh = tb - hy;
  // Never smaller than the tight plate at ÷DS, so the two halves can't overlap.
  w = Math.max(pw / DS, Math.round(w));
  h = Math.max(ph / DS, Math.round(h));
  const cw = w * DS;
  const ch = h * DS;
  const mw = cw - pw; // inserted middle width  (extruded plain span)
  const mh = ch - ph; // inserted middle height
  const key = `${kind}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false; // nearest-neighbour, always
  // Four TIGHT corner blocks, drawn 1:1 flush to the canvas corners — outline,
  // gold bevel, rounded corner AND the inner engraved-line corner, no scale.
  g.drawImage(img, tl, tt, lw, th, 0, 0, lw, th); // TL
  g.drawImage(img, hx, tt, rw, th, cw - rw, 0, rw, th); // TR
  g.drawImage(img, tl, hy, lw, bh, 0, ch - bh, lw, bh); // BL
  g.drawImage(img, hx, hy, rw, bh, cw - rw, ch - bh, rw, bh); // BR
  // Extrude the single plain column/row at the cut across the inserted gap —
  // a seamless texture stretch (the outline runs straight through), no smear.
  if (mw > 0) {
    g.drawImage(img, hx, tt, 1, th, lw, 0, mw, th); // top edge
    g.drawImage(img, hx, hy, 1, bh, lw, ch - bh, mw, bh); // bottom edge
  }
  if (mh > 0) {
    g.drawImage(img, tl, hy, lw, 1, 0, th, lw, mh); // left edge
    g.drawImage(img, hx, hy, rw, 1, cw - rw, th, rw, mh); // right edge
  }
  if (mw > 0 && mh > 0) g.drawImage(img, hx, hy, 1, 1, lw, th, mw, mh); // centre
  const url = cv.toDataURL();
  cache.set(key, url);
  return url;
}

/** Dress a button element with a composed plate that tracks its size and
 * pressed/selected state — a drop-in for the old border-image plate. The
 * element keeps its own padding/min-height; we only paint the background. */
export function dressPlate(el: HTMLElement, kindFor: (el: HTMLElement) => PlateKind) {
  const paint = () => {
    const url = plateUrl(kindFor(el), el.clientWidth, el.clientHeight);
    if (url) el.style.backgroundImage = `url(${url})`;
  };
  readyPlates().then(paint);
  new ResizeObserver(paint).observe(el);
  // repaint when the pressed/selected class flips
  new MutationObserver(paint).observe(el, { attributes: true, attributeFilter: ["class"] });
}

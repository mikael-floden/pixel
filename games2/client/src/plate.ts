/**
 * Runtime-composed button plates — the SAME philosophy as the page frame
 * (frame2.ts) and exactly what the maintainer asked for: "cut the button in
 * half and use texture from the button to fill it out" + "always use nearest
 * neighbour".
 *
 * The plate art (224²) is cut down the MIDDLE into four 112² quarters. Those
 * quarters carry everything decorated — the outline, the gold bevel, the
 * rounded corners AND the corners of the inner engraved line — and are drawn
 * 1:1 at NATIVE resolution into the corners of the canvas (never scaled, so
 * the outline + 1px inner line stay pixel-exact). The gap between the halves
 * is filled by extruding the single plain column/row at the cut — a wood
 * texture with the border/inner-line running straight through it — stretched
 * to any width/height. Because it's a plain 1px slice, stretching it is a
 * seamless extrusion, not a smear.
 *
 * The whole thing is composed at 2× the CSS button size (DS=2), then the
 * button's `background-size:100% 100%` displays it at ÷2 — a CLEAN integer
 * nearest-neighbour step (image-rendering:pixelated). The old code scaled a
 * 56px corner slice down to 26px (0.46×, non-integer) which jaggied the
 * outline and mangled the 1px engraved line; native-compose + integer ÷2
 * removes that entirely.
 */

export type PlateKind = "normal" | "pressed" | "selected";

const SRC: Record<PlateKind, string> = {
  normal: "/ui2/plate-normal.png",
  pressed: "/ui2/plate-pressed.png",
  selected: "/ui2/plate-selected.png",
};

const A = 224; // plate art size
const HALF = 112; // cut the plate in HALF (maintainer): the two halves keep
// their rounded ends + the engraved-line corners; the plain middle between
// them is filled by extruding the exact cut column/row — NEVER scaled.
const DS = 2; // display downscale: compose at NATIVE res then show at ÷2, a
// CLEAN integer (nearest-neighbour) step. The old code scaled the 56px slice
// to 26px (0.46×, non-integer) which jaggied the outline + 1px engraved line.

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
  // CSS box, then the native compose canvas at DS× (÷DS is the clean display).
  w = Math.max(A / DS, Math.round(w));
  h = Math.max(A / DS, Math.round(h));
  const cw = w * DS;
  const ch = h * DS;
  // Each half keeps its full HALF×HALF art, unless the box is so small the two
  // halves would overlap — then clamp them to meet in the middle (rare; button
  // min-height keeps ch ≥ A in practice, so no clamp and 1:1 native corners).
  const qw = Math.min(HALF, Math.floor(cw / 2));
  const qh = Math.min(HALF, Math.floor(ch / 2));
  const key = `${kind}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false; // nearest-neighbour, always
  const mw = cw - 2 * qw; // middle gap width (the extruded plain span)
  const mh = ch - 2 * qh; // middle gap height
  // Four native quarters — outline, gold bevel, rounded corners AND the inner
  // engraved-line corners, drawn 1:1 (no scale) into the canvas corners.
  g.drawImage(img, 0, 0, HALF, HALF, 0, 0, qw, qh); // TL
  g.drawImage(img, A - HALF, 0, HALF, HALF, cw - qw, 0, qw, qh); // TR
  g.drawImage(img, 0, A - HALF, HALF, HALF, 0, ch - qh, qw, qh); // BL
  g.drawImage(img, A - HALF, A - HALF, HALF, HALF, cw - qw, ch - qh, qw, qh); // BR
  // Extrude the single plain column/row at the cut (HALF) across the gap — a
  // seamless texture stretch (plate centre is plain wood), never a smear.
  if (mw > 0) {
    g.drawImage(img, HALF, 0, 1, HALF, qw, 0, mw, qh); // top edge
    g.drawImage(img, HALF, A - HALF, 1, HALF, qw, ch - qh, mw, qh); // bottom edge
  }
  if (mh > 0) {
    g.drawImage(img, 0, HALF, HALF, 1, 0, qh, qw, mh); // left edge
    g.drawImage(img, A - HALF, HALF, HALF, 1, cw - qw, qh, qw, mh); // right edge
  }
  if (mw > 0 && mh > 0) g.drawImage(img, HALF, HALF, 1, 1, qw, qh, mw, mh); // centre
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

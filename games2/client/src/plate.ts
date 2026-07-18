/**
 * Runtime-composed button plates — the SAME philosophy as the page frame
 * (frame2.ts): the plain middle is a 1px EXTRUSION, never a stretch. CSS
 * border-image stretched the square 224² plate art across wide buttons
 * (maintainer: "the button texture looks stretched" — the wood grain + the
 * inner engraved line smeared ~3× on the settings buttons). Here a canvas
 * 9-slice draws the four rounded corners at their fixed scale and fills the
 * edges/centre by stretching 1px-wide source slices — which, being a single
 * plain column/row, extends seamlessly to any size (imageSmoothingEnabled
 * off keeps it crisp). The inner line's corners live in the corner slices;
 * its straight segments come from the extruded edges, so it stays a clean
 * rounded rectangle at any width.
 */

export type PlateKind = "normal" | "pressed" | "selected";

const SRC: Record<PlateKind, string> = {
  normal: "/ui2/plate-normal.png",
  pressed: "/ui2/plate-pressed.png",
  selected: "/ui2/plate-selected.png",
};

const A = 224; // plate art size
const SL = 56; // 9-slice corner slice (matches the old border-image slice)
const CX = 112; // extruded column (plain vertical profile: bevel + inner line + wood)
const CY = 112; // extruded row
const DC = 26; // on-screen corner size (matches the old 26px border-image width)

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

/** A data-URL plate composed to exactly w×h CSS px (cached). null until the
 * art has loaded — callers re-run after readyPlates(). */
export function plateUrl(kind: PlateKind, w: number, h: number): string | null {
  const img = imgs[kind];
  if (!img) return null;
  w = Math.max(2 * DC, Math.round(w));
  h = Math.max(2 * DC, Math.round(h));
  const dc = Math.min(DC, Math.floor(w / 2), Math.floor(h / 2));
  const key = `${kind}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  const mw = w - 2 * dc; // middle dest width
  const mh = h - 2 * dc; // middle dest height
  // corners (fixed, at their own scale — same 56->26 as the old border)
  g.drawImage(img, 0, 0, SL, SL, 0, 0, dc, dc);
  g.drawImage(img, A - SL, 0, SL, SL, w - dc, 0, dc, dc);
  g.drawImage(img, 0, A - SL, SL, SL, 0, h - dc, dc, dc);
  g.drawImage(img, A - SL, A - SL, SL, SL, w - dc, h - dc, dc, dc);
  // edges: a 1px source slice stretched = a plain extrusion (frame-style)
  if (mw > 0) {
    g.drawImage(img, CX, 0, 1, SL, dc, 0, mw, dc); // top
    g.drawImage(img, CX, A - SL, 1, SL, dc, h - dc, mw, dc); // bottom
  }
  if (mh > 0) {
    g.drawImage(img, 0, CY, SL, 1, 0, dc, dc, mh); // left
    g.drawImage(img, A - SL, CY, SL, 1, w - dc, dc, dc, mh); // right
  }
  // centre: a single plain pixel extruded both ways
  if (mw > 0 && mh > 0) g.drawImage(img, CX, CY, 1, 1, dc, dc, mw, mh);
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

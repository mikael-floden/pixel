/**
 * Button plates from the maintainer's UI kit (2026-07-18, client/ui-src/
 * uikit.png, cut by scripts/extract-uikit.py) — "we have the buttons we
 * should use in the game now".
 *
 * Three plates, all FLAT pixel art at native 1x:
 * - row     (70x12) the pop-up row bar — settings toggles OFF
 * - rowSel  (70x12) the same bar with the kit's gold selection ring —
 *           settings toggles ON / pressed
 * - action  (48x16) the standalone button (outline + bottom shadow) —
 *           one-shot buttons (Log out)
 *
 * Because the art is flat, the 9-slice is LOSSLESS: corners scale by an
 * INTEGER factor k = floor(boxHeight / nativeHeight) (nearest-neighbour,
 * every art pixel becomes a crisp k×k block) and the straight runs extrude
 * a single uniform slice to any length. None of the previous generations'
 * texture-stretching hazards exist here — no grain to smear, no bevel to
 * thin, no non-integer scaling anywhere.
 */

export type PlateKind = "row" | "rowSel" | "action";

const SRC: Record<PlateKind, string> = {
  row: "/ui2/kit-row.png",
  rowSel: "/ui2/kit-row-sel.png",
  action: "/ui2/kit-btn.png",
};

// native corner slice: covers the rounding + ring/outline of every plate
const CS = 4;

const imgs: Partial<Record<PlateKind, HTMLImageElement>> = {};
const cache = new Map<string, string>();
let readyP: Promise<void> | null = null;

/** Preload the plate images (idempotent). */
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

/** A data-URL plate composed to exactly w×h CSS px: corners at integer k,
 * flat runs extruded. null until the art has loaded. */
export function plateUrl(kind: PlateKind, w: number, h: number): string | null {
  const img = imgs[kind];
  if (!img) return null;
  w = Math.round(w);
  h = Math.round(h);
  if (w < 2 || h < 2) return null;
  const k = Math.max(1, Math.floor(h / img.height));
  const cs = Math.min(CS * k, w >> 1, h >> 1);
  const key = `${kind}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const nw = img.width;
  const nh = img.height;
  const mx = nw >> 1; // flat mid slices
  const my = nh >> 1;
  const c = Math.ceil(cs / k); // native slice size backing the k-scaled corner
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false; // nearest-neighbour, always
  g.drawImage(img, 0, 0, c, c, 0, 0, cs, cs); // TL
  g.drawImage(img, nw - c, 0, c, c, w - cs, 0, cs, cs); // TR
  g.drawImage(img, 0, nh - c, c, c, 0, h - cs, cs, cs); // BL
  g.drawImage(img, nw - c, nh - c, c, c, w - cs, h - cs, cs, cs); // BR
  const mw = w - 2 * cs;
  const mh = h - 2 * cs;
  if (mw > 0) {
    g.drawImage(img, mx, 0, 1, c, cs, 0, mw, cs); // top
    g.drawImage(img, mx, nh - c, 1, c, cs, h - cs, mw, cs); // bottom
  }
  if (mh > 0) {
    g.drawImage(img, 0, my, c, 1, 0, cs, cs, mh); // left
    g.drawImage(img, nw - c, my, c, 1, w - cs, cs, cs, mh); // right
  }
  if (mw > 0 && mh > 0) g.drawImage(img, mx, my, 1, 1, cs, cs, mw, mh); // centre
  const url = cv.toDataURL();
  cache.set(key, url);
  return url;
}

type Dressed = HTMLElement & { _paintPlate?: () => void };

/** Dress a button element with a composed plate that tracks its size and
 * state. The element keeps its own padding/height; we only paint the
 * background. */
export function dressPlate(el: HTMLElement, kindFor: (el: HTMLElement) => PlateKind) {
  const paint = () => {
    const url = plateUrl(kindFor(el), el.clientWidth, el.clientHeight);
    if (url) el.style.backgroundImage = `url(${url})`;
  };
  (el as Dressed)._paintPlate = paint;
  el.setAttribute("data-plate", "");
  readyPlates().then(paint);
  new ResizeObserver(paint).observe(el);
  // repaint when the pressed/selected class flips
  new MutationObserver(paint).observe(el, { attributes: true, attributeFilter: ["class"] });
}

/** Repaint every dressed plate under `root`. A plate button built inside a
 * `display:none` page measures 0×0; the ResizeObserver reveal when the page
 * is shown can race image load and leave one unpainted. Call this once the
 * page is visible (next frame) so each plate composes at its real size. */
export function repaintPlates(root: ParentNode) {
  root.querySelectorAll<Dressed>("[data-plate]").forEach((el) => el._paintPlate?.());
}

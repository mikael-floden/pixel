/**
 * Runtime-composed button plates — the SAME philosophy as the page frame
 * (frame2.ts): a 9-slice that draws the decorated corners once and extrudes a
 * single plain column/row for the straight runs, so wide buttons never smear
 * the wood grain / inner engraved line the way a stretched border-image did.
 *
 * Two things the maintainer's zoom-ins nailed:
 *
 * 1) The plate PNG is NOT full-bleed — the 224² canvas floats the plate in a
 *    wide transparent margin (real art at x≈26..197, y≈20..207; TRIM below).
 *    So we slice from the TIGHT rect and seat the corner blocks FLUSH to the
 *    button edges; the outline runs straight into the button's real corners
 *    (an earlier version floated the rounded corner mid-edge with the page gap
 *    bleeding through — the corners he marked in red).
 *
 * 2) Render at 1× NATIVE, not shrunk. Composing at 2× and showing at ÷2 put
 *    the plate at 0.5× native, which collapsed its ~3px outline to a thin ~1px
 *    line — the "ugly 1px black border" he marked in blue. The tab plates read
 *    as a chunky beveled border because they're at ~1× native; matching that
 *    means drawing the corners 1:1 into a CSS-sized canvas (the browser's
 *    devicePixelRatio upscale is nearest-neighbour via image-rendering:
 *    pixelated, exactly as the tabs upscale). A literal half-cut can't do this
 *    — its 93px half-corners won't fit a 150px button at 1× — so the corner is
 *    a fixed CS slice and the plain middle is extruded from the plate centre.
 *
 * imageSmoothingEnabled stays off throughout — nearest-neighbour, always.
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

// Corner slice (native px) taken from each tight edge — big enough to hold the
// rounded corner, the outline+bevel AND the inner engraved-line corner, small
// enough that two stack inside a 150px button at 1× native.
const CS = 54;

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

/** A data-URL plate composed at 1× NATIVE into a CSS-sized canvas (shown 1:1
 * via background-size:100% 100%; the DPR upscale is nearest-neighbour). null
 * until the art has loaded — callers re-run after readyPlates(). */
export function plateUrl(kind: PlateKind, w: number, h: number): string | null {
  const img = imgs[kind];
  if (!img) return null;
  const [tl, tt, tr, tb] = TRIM[kind];
  const mx = tl + ((tr - tl) >> 1); // plate centre — the plain extrude source
  const my = tt + ((tb - tt) >> 1);
  w = Math.max(2 * CS, Math.round(w)); // room for two corners side by side
  h = Math.max(2 * CS, Math.round(h));
  const csx = Math.min(CS, w >> 1); // corner slice, clamped on tiny boxes
  const csy = Math.min(CS, h >> 1);
  const mw = w - 2 * csx; // extruded plain span between the corners
  const mh = h - 2 * csy;
  const key = `${kind}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false; // nearest-neighbour, always
  // Four corner blocks, drawn 1:1 flush to the canvas corners — outline, gold
  // bevel, rounded corner AND the inner engraved-line corner, at full scale.
  g.drawImage(img, tl, tt, csx, csy, 0, 0, csx, csy); // TL
  g.drawImage(img, tr - csx, tt, csx, csy, w - csx, 0, csx, csy); // TR
  g.drawImage(img, tl, tb - csy, csx, csy, 0, h - csy, csx, csy); // BL
  g.drawImage(img, tr - csx, tb - csy, csx, csy, w - csx, h - csy, csx, csy); // BR
  // Extrude the single plain column/row at the plate centre across the gap —
  // a seamless texture stretch (the outline runs straight through), no smear.
  if (mw > 0) {
    g.drawImage(img, mx, tt, 1, csy, csx, 0, mw, csy); // top edge
    g.drawImage(img, mx, tb - csy, 1, csy, csx, h - csy, mw, csy); // bottom edge
  }
  if (mh > 0) {
    g.drawImage(img, tl, my, csx, 1, 0, csy, csx, mh); // left edge
    g.drawImage(img, tr - csx, my, csx, 1, w - csx, csy, csx, mh); // right edge
  }
  if (mw > 0 && mh > 0) g.drawImage(img, mx, my, 1, 1, csx, csy, mw, mh); // centre
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

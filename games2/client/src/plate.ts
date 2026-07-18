/**
 * Button plates from the maintainer's UI kit (2026-07-18, client/ui-src/
 * uikit.png, cut by scripts/extract-uikit.py) — "we have the buttons we
 * should use in the game now".
 *
 * The maintainer circled the kit's button state trio ("Normal, Selected,
 * Down") — three flat bars at native 1x, used for EVERY HUD button:
 * - normal (48x12) mid-brown bar, dark outline, bottom shadow
 * - sel    (48x12) the cream bar — settings toggles ON
 * - down   (48x11) the dark bar, shadowless and 1px shorter (pressed into
 *          the surface) — shown while a button is held
 *
 * Because the art is flat, the 9-slice is LOSSLESS: corners scale by an
 * INTEGER factor k = floor(boxHeight / nativeHeight) (nearest-neighbour,
 * every art pixel becomes a crisp k×k block) and the straight runs extrude
 * a single uniform slice to any length. None of the previous generations'
 * texture-stretching hazards exist here — no grain to smear, no bevel to
 * thin, no non-integer scaling anywhere.
 */

export type PlateKind = "normal" | "sel" | "down" | "slot";

const SRC: Record<PlateKind, string> = {
  normal: "/ui2/kit-btn-normal.png",
  sel: "/ui2/kit-btn-sel.png",
  down: "/ui2/kit-btn-down.png",
  slot: "/ui2/kit-slot.png", // the empty item slot — an "empty button" square
};

// ONE art-pixel block size for every kit graphic (maintainer: slots had
// bigger pixels than buttons — "should be same when you use UI-kit
// graphics"). Small boxes (compact mode) drop to whatever fits.
const KIT_PX = 5;

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
  const k = Math.min(KIT_PX, Math.max(1, Math.floor(h / img.height)));
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

// The kit's DOWN bar is authored 1 art-pixel lower than the normal bar
// (pressed into the surface), so a pressed plate's CONTENT — label, icon,
// caret — dips with it: HALF a kit pixel at the element's OWN block scale
// (published as --ml-kitpx by paint; a full kit pixel read as "moved down
// too much", maintainer). Children only: every plated control is
// display:flex, so children are blockified and transformable; bare text
// nodes can't shift — wrap labels in a <span>.
let plateCssInjected = false;
function injectPlateCss() {
  if (plateCssInjected) return;
  plateCssInjected = true;
  const s = document.createElement("style");
  s.textContent = `[data-plate].press>*{translate:0 calc(var(--ml-kitpx,5px) / 2)}`;
  document.head.appendChild(s);
}

/** Dress a button element with a composed plate that tracks its size and
 * state. The element keeps its own padding/height; we only paint the
 * background. */
export function dressPlate(el: HTMLElement, kindFor: (el: HTMLElement) => PlateKind) {
  injectPlateCss();
  const paint = () => {
    const kind = kindFor(el);
    const url = plateUrl(kind, el.clientWidth, el.clientHeight);
    if (url) {
      el.style.backgroundImage = `url(${url})`;
      const im = imgs[kind]!;
      const k = Math.min(KIT_PX, Math.max(1, Math.floor(el.clientHeight / im.height)));
      el.style.setProperty("--ml-kitpx", `${k}px`);
    }
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

// ---- the kit's empty item slot ------------------------------------------
/** Dress a backpack slot as an "empty button": the kit slot square 9-sliced
 * to the box at the shared KIT_PX block size, exactly like the buttons. */
export function dressSlot(el: HTMLElement) {
  dressPlate(el, () => "slot");
}

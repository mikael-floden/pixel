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

// ONE art-pixel block size (CSS px) for every kit graphic — the plate art is
// low-res (extract-uikit downscales the 2x-grid sheet to 48x12 / 16x14), so
// this is the render block scale. Dropped 5 -> 2 so the kit graphics stop
// reading ~2x bigger than the high-res icons (maintainer 2026-07-23: "the
// UI-kit pixels look ~2x as big ... make all graphics from UI-kit half the
// current pixel size, while still drawing the button area the same size" — the
// box size is set by layout, only the block scale changes). Small boxes drop
// to whatever fits.
//
// KIT_PX is the block size AT THE APPROVED VIEW (the maintainer's desktop-site
// phone view, innerWidth 980). Art inside a uiZoom'd overlay root (the bars,
// the select screen) keeps this fixed value — the compensating zoom already
// shrinks its blocks on device-width viewports. Art in the UN-zoomed HUD
// (tabs/slots/settings plates, dressed with frameScaled) must instead scale
// its blocks WITH the frame via hudKitPx(): a fixed 2 CSS px there read ~2.5x
// too chunky next to the bars in mobile view (maintainer 2026-07-29: "the
// pixels look twice as big").
const KIT_PX = 2;

// --ml-fs at the approved view: min(980/768, 2123/1376) × HUD_SCALE(0.75)
// = 0.95703125. A frozen CALIBRATION constant — deliberately NOT imported
// from frame2: if HUD_SCALE ever changes, the whole HUD resizes and the
// blocks should ride along, which only a frozen reference gives.
const FS_REF = 0.95703125;

/** Kit block size (CSS px) for art in the UN-zoomed HUD: KIT_PX scaled by the
 * frame's current render scale relative to the approved view, so the plate
 * grain shrinks/grows exactly like the frame, the icons and the (zoomed) bars.
 * Falls back to the same 0.75 default the --ml-fs CSS fallbacks use. */
export function hudKitPx(): number {
  const fs = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--ml-fs"),
  );
  return (KIT_PX * (fs > 0 ? fs : 0.75)) / FS_REF;
}

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

/** 9-slice `img` to a w×h CSS box: corners at the integer block scale k, flat
 * runs extruded — the same lossless composition every kit graphic uses. Baked
 * at `scale`× resolution: pass the DEVICE pixel ratio for a background-image
 * plate (maps 1:1 to physical px so the phone's desktop-site zoom can't blur
 * it), or 1 for an <img> that upscales itself crisply with image-rendering:
 * pixelated (the health bar — bars.ts — 9-slices its frame/fill this way so it
 * keeps its box while the blocks shrink to KIT_PX, exactly like the buttons).
 * imageSmoothingEnabled stays off so every block is hard. */
export function nineSlice(
  img: HTMLImageElement,
  w: number,
  h: number,
  scale = Math.max(1, window.devicePixelRatio || 1),
  kitPx = KIT_PX, // pass hudKitPx() for art in the UN-zoomed HUD
): string | null {
  w = Math.round(w);
  h = Math.round(h);
  if (w < 2 || h < 2) return null;
  const k = Math.min(kitPx, Math.max(1, Math.floor(h / img.height)));
  const cs = Math.min(CS * k, w >> 1, h >> 1);
  const nw = img.width;
  const nh = img.height;
  const mx = nw >> 1; // flat mid slices
  const my = nh >> 1;
  const c = Math.ceil(cs / k); // native slice size backing the k-scaled corner
  // destination geometry in canvas px (× scale); source slices stay native
  const W = Math.round(w * scale);
  const H = Math.round(h * scale);
  const CSd = Math.round(cs * scale);
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d")!;
  g.imageSmoothingEnabled = false; // nearest-neighbour, always
  g.drawImage(img, 0, 0, c, c, 0, 0, CSd, CSd); // TL
  g.drawImage(img, nw - c, 0, c, c, W - CSd, 0, CSd, CSd); // TR
  g.drawImage(img, 0, nh - c, c, c, 0, H - CSd, CSd, CSd); // BL
  g.drawImage(img, nw - c, nh - c, c, c, W - CSd, H - CSd, CSd, CSd); // BR
  const mw = W - 2 * CSd;
  const mh = H - 2 * CSd;
  if (mw > 0) {
    g.drawImage(img, mx, 0, 1, c, CSd, 0, mw, CSd); // top
    g.drawImage(img, mx, nh - c, 1, c, CSd, H - CSd, mw, CSd); // bottom
  }
  if (mh > 0) {
    g.drawImage(img, 0, my, c, 1, 0, CSd, CSd, mh); // left
    g.drawImage(img, nw - c, my, c, 1, W - CSd, CSd, CSd, mh); // right
  }
  if (mw > 0 && mh > 0) g.drawImage(img, mx, my, 1, 1, CSd, CSd, mw, mh); // centre
  return cv.toDataURL();
}

/** A data-URL plate for a box of w×h CSS px (background-image path — device
 * resolution). null until the art has loaded. */
export function plateUrl(
  kind: PlateKind,
  w: number,
  h: number,
  kitPx = KIT_PX,
): string | null {
  const img = imgs[kind];
  if (!img) return null;
  const rw = Math.round(w);
  const rh = Math.round(h);
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const key = `${kind}:${rw}x${rh}@${scale}k${kitPx.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = nineSlice(img, rw, rh, scale, kitPx);
  if (url) cache.set(key, url);
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
  // Every plate's composed image fills its box exactly (it is baked to the
  // element's size); pin background-size so a DEVICE-resolution bake — bigger
  // than the CSS box — still fits instead of tiling/overflowing.
  s.textContent =
    `[data-plate]{background-size:100% 100%;background-repeat:no-repeat}` +
    `[data-plate].press>*{translate:0 calc(var(--ml-kitpx,2px) / 2)}`;
  document.head.appendChild(s);
}

/** Dress a button element with a composed plate that tracks its size and
 * state. The element keeps its own padding/height; we only paint the
 * background. `frameScaled: true` for elements in the UN-zoomed HUD — their
 * blocks track the frame scale (hudKitPx); leave false inside a uiZoom'd
 * overlay root (the select screen), where the zoom scales the blocks. */
export function dressPlate(
  el: HTMLElement,
  kindFor: (el: HTMLElement) => PlateKind,
  frameScaled = false,
) {
  injectPlateCss();
  const paint = () => {
    const kind = kindFor(el);
    const kp = frameScaled ? hudKitPx() : KIT_PX;
    const url = plateUrl(kind, el.clientWidth, el.clientHeight, kp);
    if (url) {
      el.style.backgroundImage = `url(${url})`;
      const im = imgs[kind]!;
      const k = Math.min(kp, Math.max(1, Math.floor(el.clientHeight / im.height)));
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
 * to the box at the shared block size, exactly like the buttons. Slots live
 * in the un-zoomed HUD, so their blocks track the frame (frameScaled). */
export function dressSlot(el: HTMLElement) {
  dressPlate(el, () => "slot", true);
}

/**
 * HUD frame v2 — the vine/crystal/clock frame from the second concept round,
 * composed AT RUNTIME to any viewport size from two assets:
 *
 *   /ui2/frame.png              the extracted 768×1376 frame (RGBA)
 *   /ui2/frame-top-runefree.png rows 0-99 with both rune glyphs inpainted
 *                               away (the stretch fills sample this so no
 *                               rune pixel ever repeats)
 *
 * The compose is a pixel-exact port of the maintainer-approved dummy
 * builder (scratchpad hud2-tilespec.json, 2026-07-17): every stretchable
 * member repeats PLAIN texture only — single-column/row extrusions where
 * possible — so any number of pixels can be inserted on either axis, and
 * every joint is a pair of originally-adjacent pixels:
 *
 *   top rail    two cuts: vertical x=196 (left of the N rune) and a kinked
 *               diagonal x=534+y that dodges the C rune; fills extrude the
 *               exact rune-free column at each cut, rows 0-99.
 *   rail A      cut x=451, 12px plain plank [445,457); groove rows 669-685
 *               extruded from col 451 (no tick repetition).
 *   rail B      cut x=392, 100px unit [292,392) (tiles invisibly).
 *   bottom      cut x=383, 12px plank [377,389); underside rows 1362-1369
 *               extruded from col 383.
 *   verticals   height stretch 1: single row 326 extruded (rune-free on
 *               both rails); height stretch 2: 86px winding-bark unit
 *               rows [992,1078) at y=1035 (kept per maintainer - looks
 *               organic); arbitrary heights put the non-multiple remainder
 *               into stretch 1.
 *
 * The canvas mounts fixed/fullscreen, pointer-transparent, and is CSS-scaled
 * (nearest-neighbour) by s = min(W/768, H/1376) so the art never shrinks
 * below its native proportions; the axis with head-room gets the insert.
 * Layout consumers (HudBar, the #game split) get the window rectangles in
 * CSS px through the onLayout callback.
 */

const AW = 768;
const AH = 1376;

// ---- cut geometry (hud2-tilespec.json) ----
const CUT_L = 196; // vertical, clears the left strand and the N rune
function cutR(y: number): number {
  if (y > 92) return 626;
  const base = 534 + y;
  if (y >= 15 && y <= 48) return Math.max(base, 576); // dodge the C rune
  return base;
}
const TOP_FILL_ROWS = 100; // rows that carry beam art at the top cuts

interface HMember {
  y0: number; y1: number; cx: number; p: number; s0: number;
  flat?: [number, number][]; fc?: number;
}
const H_MEMBERS: HMember[] = [
  { y0: 630, y1: 760, cx: 451, p: 12, s0: 445, flat: [[669, 686]], fc: 451 },
  { y0: 760, y1: 905, cx: 392, p: 100, s0: 292 },
  { y0: 1280, y1: 1376, cx: 383, p: 12, s0: 377, flat: [[1362, 1370]], fc: 383 },
];
const WIN_CUT = 384; // window bands: cut through transparency

const VCUT1 = 326; // single-row extrusion (rune-free on both rails)
const VCUT2 = { y: 1035, s0: 992, p: 86 }; // winding-bark unit

// where the animated clock hand's pivot hangs, just below the strap stub
// (maintainer's blue dot, updated once). Between the top-rail cuts, so it
// shifts by the left insert half; above VCUT1, so no vertical shift.
const CLOCK_ANCHOR = { x: 385, y: 88 };

// ---- interior windows (asset coords, MEASURED off frame.png's alpha) ----
const RAIL_TOP_Y = 648;                   // rail A's visual top edge (ragged)
const RAIL_SOLID_Y = 676;                 // inside rail A's full-width-opaque
                                          // band (rows 665-693) — the REAL
                                          // game/HUD split: the game canvas
                                          // renders down to here so the rail
                                          // art overlaps the world (maintainer:
                                          // "the in-game viewport should render
                                          // all the way down"), while chat still
                                          // anchors above RAIL_TOP_Y
// tab window: the brown band between rail A and rail B — its true side span
// (rows 703-845) matches the page window's rail edges, so the tab row's
// outer margins come out equal to its inter-button gaps (maintainer: "the
// menu buttons are still not spaced correctly")
const TAB_WIN = { x0: 48, x1: 720, y0: 714, y1: 844 };
// page window = where the stone is actually exposed: rail B's art ends at
// row 869 (center span), the bottom rail's ragged art starts at 1310, and
// the vertical rails' inner edges sit at x 42/725 (median) — the old
// eyeballed 80..692 / 912..1298 left big dead margins the maintainer marked
// ("the spacing should look even")
const PAGE_WIN = { x0: 48, x1: 720, y0: 874, y1: 1306 };
const PAGE_TUCK_Y = 848;                  // rail B's top edge — the stone
                                          // backdrop starts HERE, under the
                                          // opaque rail art, so no dark gap
                                          // can open between rail and stone
                                          // (maintainer marked exactly that)

export interface FrameLayout {
  /** css px per asset px */
  scale: number;
  /** css-px y of the game/HUD boundary — INSIDE rail A's opaque band, so the
   * game canvas runs under the rail's ragged top and the frame overlays it */
  gameHeight: number;
  /** css-px y of rail A's visual (ragged) top edge — chat anchors above this */
  railTop: number;
  /** css-px point the animated clock hand's pivot mounts to (the strap stub) */
  clockAnchor: { x: number; y: number };
  /** css-px y where the stone page backdrop must start (under rail B) */
  pageTuckTop: number;
  tabRect: { left: number; top: number; width: number; height: number };
  pageRect: { left: number; top: number; width: number; height: number };
}

let canvas: HTMLCanvasElement | null = null;
let frameData: ImageData | null = null;
let auxData: ImageData | null = null;
let layoutCb: ((l: FrameLayout) => void) | null = null;

function loadImageData(url: string): Promise<ImageData> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      res(g.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = rej;
    img.src = url;
  });
}

/** widen the 768-wide asset to w0 (>=768) — port of the dummy's pass 1 */
function widen(src: ImageData, aux: ImageData, w0: number): ImageData {
  const insW = w0 - AW;
  const gl = insW >> 1;
  const gr = insW - gl;
  const out = new ImageData(w0, AH);
  const S = src.data, A = aux.data, O = out.data;
  const copy = (y: number, sx0: number, sx1: number, dx: number) => {
    O.set(S.subarray((y * AW + sx0) * 4, (y * AW + sx1) * 4), (y * w0 + dx) * 4);
  };
  const put = (buf: Uint8ClampedArray, si: number, y: number, dx0: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const d = (y * w0 + dx0 + i) * 4;
      O[d] = buf[si]; O[d + 1] = buf[si + 1]; O[d + 2] = buf[si + 2]; O[d + 3] = buf[si + 3];
    }
  };
  for (let y = 0; y < AH; y++) {
    if (y < 630) {
      const cr = cutR(y);
      copy(y, 0, CUT_L, 0);
      copy(y, CUT_L, cr, CUT_L + gl);
      copy(y, cr, AW, cr + insW);
      if (y < TOP_FILL_ROWS) {
        put(A, (y * AW + CUT_L) * 4, y, CUT_L, gl);       // extrude cut column
        put(A, (y * AW + cr) * 4, y, cr + gl, gr);        // extrude cut-line pixel
      }
    } else {
      let m: HMember | undefined;
      for (const mm of H_MEMBERS) if (y >= mm.y0 && y < mm.y1) { m = mm; break; }
      const cx = m ? m.cx : WIN_CUT;
      copy(y, 0, cx, 0);
      copy(y, cx, AW, cx + insW);
      if (m) {
        const inflat = m.flat?.some(([a, b]) => y >= a && y < b);
        if (inflat) {
          put(S, (y * AW + m.fc!) * 4, y, cx, insW);
        } else {
          for (let r = 0; r < insW; r++) {
            const sx = m.s0 + ((cx - m.s0 + r) % m.p);
            const si = (y * AW + sx) * 4;
            const d = (y * w0 + cx + r) * 4;
            O[d] = S[si]; O[d + 1] = S[si + 1]; O[d + 2] = S[si + 2]; O[d + 3] = S[si + 3];
          }
        }
      }
    }
  }
  return out;
}

/** heighten the widened image to h0 (>=1376) — port of pass 2 */
function heighten(wideImg: ImageData, h0: number, g1: number, g2: number): ImageData {
  const w0 = wideImg.width;
  const out = new ImageData(w0, h0);
  const S = wideImg.data, O = out.data;
  const row = (sy: number, dy: number) =>
    O.set(S.subarray(sy * w0 * 4, (sy + 1) * w0 * 4), dy * w0 * 4);
  let dy = 0;
  for (let y = 0; y < VCUT1; y++) row(y, dy++);
  for (let r = 0; r < g1; r++) row(VCUT1, dy++);
  for (let y = VCUT1; y < VCUT2.y; y++) row(y, dy++);
  for (let r = 0; r < g2; r++) row(VCUT2.s0 + ((VCUT2.y - VCUT2.s0 + r) % VCUT2.p), dy++);
  for (let y = VCUT2.y; y < AH; y++) row(y, dy++);
  return out;
}

function splitInsH(insH: number): [number, number] {
  // ALL vertical head-room goes to the game view (the stretch ABOVE rail A):
  // the HUD keeps its base art height and the world gets every spare pixel
  // (maintainer: "make the game-view bigger and HUD smaller"). The 86px
  // bark-unit stretch below (VCUT2/g2) stays wired for the day the page
  // window needs to grow again.
  return [insH, 0];
}

function compose() {
  if (!canvas || !frameData || !auxData) return;
  const wCss = window.innerWidth;
  const hCss = window.innerHeight;
  const s = Math.min(wCss / AW, hCss / AH);
  const w0 = Math.max(AW, Math.round(wCss / s));
  const h0 = Math.max(AH, Math.round(hCss / s));
  const [g1, g2] = splitInsH(h0 - AH);
  const img = heighten(widen(frameData, auxData, w0), h0, g1, g2);
  canvas.width = w0;
  canvas.height = h0;
  canvas.getContext("2d")!.putImageData(img, 0, 0);
  canvas.style.width = `${wCss}px`;
  canvas.style.height = `${hCss}px`;

  const insW = w0 - AW;
  const layout: FrameLayout = {
    scale: s,
    gameHeight: (RAIL_SOLID_Y + g1) * s,
    railTop: (RAIL_TOP_Y + g1) * s,
    clockAnchor: {
      x: (CLOCK_ANCHOR.x + (insW >> 1)) * s,
      y: CLOCK_ANCHOR.y * s,
    },
    pageTuckTop: (PAGE_TUCK_Y + g1) * s,
    tabRect: {
      left: TAB_WIN.x0 * s,
      top: (TAB_WIN.y0 + g1) * s,
      width: (TAB_WIN.x1 + insW - TAB_WIN.x0) * s,
      height: (TAB_WIN.y1 - TAB_WIN.y0) * s,
    },
    pageRect: {
      left: PAGE_WIN.x0 * s,
      top: (PAGE_WIN.y0 + g1) * s,
      width: (PAGE_WIN.x1 + insW - PAGE_WIN.x0) * s,
      height: (PAGE_WIN.y1 - PAGE_WIN.y0 + g2) * s,
    },
  };
  layoutCb?.(layout);
}

// ---- character-select RING frame v2 ---------------------------------------
// Composed from the maintainer's AUTHORED ring art (2026-07-17), cut into
// pieces by scripts/extract-select2.mjs (/ui2/select2/): four decorated
// corners pinned to the screen corners + a repeatable plain-beam strip tiled
// per side between them. Pieces render at TRUE 1:1 art pixels: the canvas
// backing is sized in real CSS px (virtual px × the overlay's uiZoom), so
// the art never resamples even though the canvas element lives inside the
// zoomed overlay. If a viewport is too narrow for two corners side by side
// (a real device-width phone), everything drops to an exact half scale.

interface Sel2Geo {
  art: { w: number; h: number };
  beams: {
    top: { y: number; h: number };
    bottom: { y: number; h: number };
    left: { x: number; w: number };
    right: { x: number; w: number };
  };
  corners: Record<"tl" | "tr" | "bl" | "br", { w: number; h: number }>;
  inner: { top: number; bottom: number; left: number; right: number };
  /** empty outer margin per corner edge — the ring shifts outward by the
   * min of each side's two corners so the beams hug the screen edge
   * (maintainer: the border sat far inside) without clipping any art */
  margins: {
    tl: { top: number; left: number };
    tr: { top: number; right: number };
    bl: { bottom: number; left: number };
    br: { bottom: number; right: number };
  };
}

let selCanvas: HTMLCanvasElement | null = null;
let selParent: HTMLElement | null = null;
let sel2Geo: Sel2Geo | null = null;
let sel2Imgs: Record<string, HTMLImageElement> | null = null;

function composeSelect() {
  if (!selCanvas || !selParent || !sel2Geo || !sel2Imgs || !selCanvas.isConnected) return;
  const vw = selParent.clientWidth; // virtual px (inside the uiZoom)
  const vh = selParent.clientHeight;
  if (!vw || !vh) return;
  const zoom = parseFloat(getComputedStyle(selParent).zoom as string) || 1;
  const bw = Math.round(vw * zoom); // backing = real CSS px → 1 art px = 1 px
  const bh = Math.round(vh * zoom);
  const g = sel2Geo, I = sel2Imgs;
  const s = bw >= (g.corners.tl.w + g.corners.tr.w) * 1.05 ? 1 : 0.5;
  selCanvas.width = bw;
  selCanvas.height = bh;
  selCanvas.style.width = `${vw}px`;
  selCanvas.style.height = `${vh}px`;
  const ctx = selCanvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, bw, bh);
  // pull the whole ring outward by each side's shared EMPTY margin (-2px
  // breathing room) so the beams hug the screen edge; corners shift
  // diagonally by their two sides, so all beam stubs stay aligned
  const m = g.margins;
  const shT = Math.max(0, Math.min(m.tl.top, m.tr.top) - 2) * s;
  const shB = Math.max(0, Math.min(m.bl.bottom, m.br.bottom) - 2) * s;
  const shL = Math.max(0, Math.min(m.tl.left, m.bl.left) - 2) * s;
  const shR = Math.max(0, Math.min(m.tr.right, m.br.right) - 2) * s;
  const yBot = (artY: number) => bh - (g.art.h - artY) * s + shB; // bottom-anchored
  const xRight = (artX: number) => bw - (g.art.w - artX) * s + shR;
  // beams first (corners overdraw their stubs), tiled along each side
  const tileH = (img: HTMLImageElement, y: number, x0: number, x1: number) => {
    for (let x = x0; x < x1; x += img.width * s)
      ctx.drawImage(img, 0, 0, Math.min(img.width, (x1 - x) / s), img.height,
        x, y, Math.min(img.width * s, x1 - x), img.height * s);
  };
  const tileV = (img: HTMLImageElement, x: number, y0: number, y1: number) => {
    for (let y = y0; y < y1; y += img.height * s)
      ctx.drawImage(img, 0, 0, img.width, Math.min(img.height, (y1 - y) / s),
        x, y, img.width * s, Math.min(img.height * s, y1 - y));
  };
  tileH(I.beamTop, g.beams.top.y * s - shT, (g.corners.tl.w - 2) * s - shL, bw - (g.corners.tr.w - 2) * s + shR);
  tileH(I.beamBottom, yBot(g.beams.bottom.y), (g.corners.bl.w - 2) * s - shL, bw - (g.corners.br.w - 2) * s + shR);
  tileV(I.beamLeft, g.beams.left.x * s - shL, (g.corners.tl.h - 2) * s - shT, bh - (g.corners.bl.h - 2) * s + shB);
  tileV(I.beamRight, xRight(g.beams.right.x), (g.corners.tr.h - 2) * s - shT, bh - (g.corners.br.h - 2) * s + shB);
  const draw = (img: HTMLImageElement, x: number, y: number) =>
    ctx.drawImage(img, x, y, img.width * s, img.height * s);
  draw(I.tl, -shL, -shT);
  draw(I.tr, bw - g.corners.tr.w * s + shR, -shT);
  draw(I.bl, -shL, bh - g.corners.bl.h * s + shB);
  draw(I.br, bw - g.corners.br.w * s + shR, bh - g.corners.br.h * s + shB);
  // content stays inside the beams' inner faces (overlay padding is in
  // VIRTUAL px — divide the backing-px band depth by the zoom)
  const pad = (v: number, sh: number) =>
    `${Math.max(0, Math.round((v * s - sh) / zoom)) + 4}px`;
  selParent.style.padding =
    `${pad(g.inner.top, shT)} ${pad(g.art.w - g.inner.right, shR)} ` +
    `${pad(g.art.h - g.inner.bottom, shB)} ${pad(g.inner.left, shL)}`;
}

/** Mount the select ring into the (uiZoom'd) select overlay. Idempotent per
 * overlay: a fresh overlay (re-entering select) gets a fresh canvas. */
export function mountSelectFrame(parent: HTMLElement) {
  selParent = parent;
  if (!selCanvas || !selCanvas.isConnected) {
    selCanvas = document.createElement("canvas");
    selCanvas.id = "ml-select-frame";
    selCanvas.style.cssText =
      "position:absolute;inset:0;z-index:3;pointer-events:none;image-rendering:pixelated";
  }
  if (!selResizeHooked) {
    selResizeHooked = true;
    window.addEventListener("resize", () => {
      window.clearTimeout(selResizeTimer);
      selResizeTimer = window.setTimeout(composeSelect, 120);
    });
  }
  parent.appendChild(selCanvas);
  if (sel2Geo && sel2Imgs) {
    composeSelect();
  } else {
    const load = (name: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = `/ui2/select2/${name}.png`;
      });
    Promise.all([
      fetch("/ui2/select2/select2.json").then((r) => r.json()),
      load("corner-tl"), load("corner-tr"), load("corner-bl"), load("corner-br"),
      load("beam-top"), load("beam-bottom"), load("beam-left"), load("beam-right"),
    ]).then(([geo, tl, tr, bl, br, beamTop, beamBottom, beamLeft, beamRight]) => {
      sel2Geo = geo as Sel2Geo;
      sel2Imgs = { tl, tr, bl, br, beamTop, beamBottom, beamLeft, beamRight };
      composeSelect();
    });
  }
}

let selResizeTimer: number | undefined;
let selResizeHooked = false;

let resizeTimer: number | undefined;

/** Mount the frame canvas (idempotent) and start relayouting on resize.
 * onLayout fires after every compose with the window geometry in CSS px. */
export function mountFrame2(onLayout: (l: FrameLayout) => void) {
  layoutCb = onLayout;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "ml-frame2";
    canvas.style.cssText =
      "position:fixed;inset:0;z-index:6;pointer-events:none;image-rendering:pixelated";
    document.body.appendChild(canvas);
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(compose, 120);
    });
    Promise.all([
      loadImageData("/ui2/frame.png"),
      loadImageData("/ui2/frame-top-runefree.png"),
    ]).then(([f, a]) => {
      frameData = f;
      auxData = a;
      compose();
    });
  } else {
    compose();
  }
}

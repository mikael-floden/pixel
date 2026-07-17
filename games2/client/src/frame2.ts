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

// ---- interior windows (asset coords; eyeballed off the concept, the
// maintainer reviews screenshots and we adjust) ----
const INNER_X0 = 80, INNER_X1 = 692;
const GAME_SPLIT_Y = 648;                 // rail A's visual top edge
const TAB_WIN = { y0: 714, y1: 844 };     // between rail A and rail B
const PAGE_WIN = { y0: 912, y1: 1298 };   // below rail B, above bottom rail

export interface FrameLayout {
  /** css px per asset px */
  scale: number;
  /** css-px y of the game/HUD boundary (top edge of rail A) */
  gameHeight: number;
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
  // roughly half into the lower (86px-unit) stretch, rounded to whole units;
  // the remainder goes to the single-row stretch which absorbs any count
  let g2 = Math.round(insH / 2 / VCUT2.p) * VCUT2.p;
  g2 = Math.max(0, Math.min(g2, insH));
  return [insH - g2, g2];
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
    gameHeight: (GAME_SPLIT_Y + g1) * s,
    tabRect: {
      left: INNER_X0 * s,
      top: (TAB_WIN.y0 + g1) * s,
      width: (INNER_X1 + insW - INNER_X0) * s,
      height: (TAB_WIN.y1 - TAB_WIN.y0) * s,
    },
    pageRect: {
      left: INNER_X0 * s,
      top: (PAGE_WIN.y0 + g1) * s,
      width: (INNER_X1 + insW - INNER_X0) * s,
      height: (PAGE_WIN.y1 - PAGE_WIN.y0 + g2) * s,
    },
  };
  layoutCb?.(layout);
}

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

/**
 * HUD frame v2 — the vine/crystal/clock frame from the second concept round,
 * composed AT RUNTIME to any viewport size from two assets:
 *
 *   /ui2/frame.png              the extracted 768×1376 frame (RGBA)
 *   /ui2/frame-top-runefree.png rows 0-99 with both rune glyphs inpainted
 *                               away (the stretch fills sample this so no
 *                               rune pixel ever repeats)
 *   (the 360° zodiac wheel is NOT baked in — clock.ts hangs it behind this
 *   canvas as a live, rotating layer; see the CLOCK note below)
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

// ---- horizontal-piece fiber donors ----
// The V-donor (grain section below) fits the ~40px-wide vertical rails. The
// HORIZONTAL fills (rail A ~130 cross rows, bottom rail, top beams) are far
// wider than its 36px cross, and the mirror-wrap put a reflected copy of the
// fiber mid-face — the maintainer circled rail A: "are you drawing this tile
// twice?". Each horizontal fill samples ITS OWN clean face as donor: the
// cross axis maps 1:1 (identity — it cannot wrap), and only the RUN
// ping-pongs along the clean span, where a mirrored horizontal streak still
// reads as a horizontal streak. Delta = pixel luma minus its row's mean over
// the span (the face's own cross profile removed), so only fiber transfers.
interface HDonor {
  aux: boolean; // sample from the runefree top-rail image instead of the frame
  x0: number; x1: number; y0: number; y1: number;
  mean?: Float32Array; // per-row luma mean over the span (built once)
}
const HD_BEAM_L: HDonor = { aux: true, x0: 121, x1: 144, y0: 0, y1: 100 };
const HD_BEAM_R: HDonor = { aux: true, x0: 633, x1: 644, y0: 0, y1: 100 };
const HD_RAIL_A: HDonor = { aux: false, x0: 446, x1: 484, y0: 630, y1: 760 };
const HD_BOTTOM: HDonor = { aux: false, x0: 450, x1: 466, y0: 1280, y1: 1376 };

interface HMember {
  y0: number; y1: number; cx: number; p: number; s0: number;
  flat?: [number, number][]; fc?: number;
  hd?: HDonor; // own-face fiber donor (12px plank members)
}
const H_MEMBERS: HMember[] = [
  { y0: 630, y1: 760, cx: 451, p: 12, s0: 445, flat: [[669, 686]], fc: 451, hd: HD_RAIL_A },
  { y0: 760, y1: 905, cx: 392, p: 100, s0: 292 },
  { y0: 1280, y1: 1376, cx: 383, p: 12, s0: 377, flat: [[1362, 1370]], fc: 383, hd: HD_BOTTOM },
];
const WIN_CUT = 384; // window bands: cut through transparency

const VCUT1 = 326; // vertical cut row (rune-free on both rails)
const VCUT2 = { y: 1035, s0: 992, p: 86 }; // winding-bark unit

// ---- grain shading (maintainer-directed, 2026-07-18) ----
// Single-slice extrusion repeats ONE colour for the whole insert and long
// runs read flat ("the wood doesn't look real when we have repeated the same
// color over and over"). A bounce-walk through neighbouring slices was tried
// and REJECTED — real neighbouring slices carry knots/edges, and repeating
// them read as "cuts" in the graphics. The maintainer's direction: keep the
// old seamless 1px stripe (perfect cross-profile, no cuts ever) and lay the
// texture of the clean rail wood he circled over it. FIBER DIRECTION MATTERS
// — a first cut drifted the whole slice per run-step, which striped the rail
// PERPENDICULAR to its length ("you drew the fiber 90° wrong"): wood fiber
// runs ALONG a beam. So the donor is kept as a true 2D patch (its fiber runs
// vertically, along its rail) and is mapped donor-fiber -> RUN direction:
// output(cross, i) = slice(cross) + donorDelta(cross, i), where the donor's
// per-pixel delta (luma minus its column mean — the donor's own cross
// profile removed) is mirror-wrapped in both axes. Fibers stay coherent
// along i = along the piece, for vertical rails and horizontal beams alike.
const GRAIN_CLAMP = 12;

interface VDonor {
  x0: number; x1: number; y0: number; y1: number;
  tex?: Int8Array; // per-pixel luma deltas vs column mean (built once)
}
// clean left-rail wood: of the GAME frame / of the SELECT border
const VD_GAME: VDonor = { x0: 8, x1: 44, y0: 941, y1: 1075 };
const VD_SEL: VDonor = { x0: 8, x1: 90, y0: 825, y1: 962 };

function buildVDonor(d: VDonor, src: ImageData) {
  const S = src.data;
  const dw = d.x1 - d.x0;
  const dh = d.y1 - d.y0;
  d.tex = new Int8Array(dw * dh);
  for (let c = 0; c < dw; c++) {
    let sum = 0;
    let cnt = 0;
    for (let r = 0; r < dh; r++) {
      const si = ((d.y0 + r) * AW + d.x0 + c) * 4;
      if (S[si + 3] > 200) {
        sum += 0.3 * S[si] + 0.6 * S[si + 1] + 0.1 * S[si + 2];
        cnt++;
      }
    }
    const mean = sum / Math.max(1, cnt);
    for (let r = 0; r < dh; r++) {
      const si = ((d.y0 + r) * AW + d.x0 + c) * 4;
      let dl = 0;
      if (S[si + 3] > 200)
        dl = 0.3 * S[si] + 0.6 * S[si + 1] + 0.1 * S[si + 2] - mean;
      d.tex[r * dw + c] = Math.max(-GRAIN_CLAMP, Math.min(GRAIN_CLAMP, Math.round(dl)));
    }
  }
}

/** donor fiber delta at (cross position, run position) — mirror-wrapped both
 * ways so the texture continues seamlessly at any size. CROSS positions must
 * be LOCAL to one piece of wood (≈ the donor's own width): a wrap inside
 * one wide face mirrors the fiber and reads as the tile drawn twice. */
function vGrainAt(d: VDonor, cross: number, i: number): number {
  if (!d.tex) return 0;
  const dw = d.x1 - d.x0;
  const dh = d.y1 - d.y0;
  const mc = cross % (2 * dw - 2);
  const mr = i % (2 * dh - 2);
  const c = mc < dw ? mc : 2 * dw - 2 - mc;
  const r = mr < dh ? mr : 2 * dh - 2 - mr;
  return d.tex[r * dw + c];
}

function buildHDonor(d: HDonor, src: ImageData) {
  const S = src.data;
  d.mean = new Float32Array(d.y1 - d.y0);
  for (let y = d.y0; y < d.y1; y++) {
    let sum = 0;
    let cnt = 0;
    for (let x = d.x0; x < d.x1; x++) {
      const si = (y * AW + x) * 4;
      if (S[si + 3] > 200) {
        sum += 0.3 * S[si] + 0.6 * S[si + 1] + 0.1 * S[si + 2];
        cnt++;
      }
    }
    // rows whose span is mostly transparent (ragged edges) carry no fiber
    d.mean[y - d.y0] = cnt >= (d.x1 - d.x0) / 2 ? sum / cnt : NaN;
  }
}

function hGrainAt(d: HDonor, src: ImageData, y: number, i: number): number {
  if (!d.mean || y < d.y0 || y >= d.y1) return 0;
  const m = d.mean[y - d.y0];
  if (Number.isNaN(m)) return 0;
  const w = d.x1 - d.x0;
  const mi = i % (2 * w - 2);
  const dx = d.x0 + (mi < w ? mi : 2 * w - 2 - mi);
  const si = (y * AW + dx) * 4;
  const S = src.data;
  if (S[si + 3] <= 200) return 0;
  const dlt = 0.3 * S[si] + 0.6 * S[si + 1] + 0.1 * S[si + 2] - m;
  return Math.max(-GRAIN_CLAMP, Math.min(GRAIN_CLAMP, Math.round(dlt)));
}

// where the animated clock hand's pivot hangs, just below the strap stub
// (maintainer's blue dot, updated once). Between the top-rail cuts, so it
// shifts by the left insert half; above VCUT1, so no vertical shift.
const CLOCK_ANCHOR = { x: 385, y: 88 };

// The CLOCK is the maintainer's full 360° zodiac WHEEL — a LIVE LAYER now,
// not baked art (2026-07-22: it rotates 180° at each day/night hand-off).
// clock.ts hangs /ui2/clock360.png (bake-clock360.py) plus the hand on the
// clockAnchor BEHIND this canvas (z 5 vs 6): the browser composites
// frame-over-wheel, so the beam and its vines cover the divide line, the
// resting upstairs half, and the hand as it flips over the top. The frame
// itself keeps the transparent hole the old disc extraction left — the
// wheel shows through it from behind.

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
// menu buttons are still not spaced correctly"). The tab row centres its
// buttons in this window, so the window must be CENTRED between the two rails
// or the buttons read low. y0/y1 was 714/844 — 4px off rail B's top (848) but
// ~18px off rail A's ragged bottom (~696), so the button sat well below rail A
// yet nearly touching rail B (maintainer 2026-07-23: "the button is not centred
// between the top and bottom frame — it's the MARGIN, outside the button").
// Centred on the true rail gap: rail A's beam bottom is asset rows 693-701
// (median 696, MEASURED off frame.png alpha) and rail B's top edge is 848, so
// the midline is row 772 — the 130-tall window centres there, giving the button
// equal margin to each beam at every viewport (the split is asset-space, so it
// holds under any scale).
const TAB_WIN = { x0: 48, x1: 720, y0: 707, y1: 837 };
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
  // the same extruded slice + own-face fiber along the run (identity cross)
  const putGrain = (buf: Uint8ClampedArray, si: number, y: number, dx0: number, n: number, hd: HDonor, hdImg: ImageData) => {
    for (let i = 0; i < n; i++) {
      const d = (y * w0 + dx0 + i) * 4;
      const g = buf[si + 3] > 0 ? hGrainAt(hd, hdImg, y, i) : 0;
      O[d] = buf[si] + g; O[d + 1] = buf[si + 1] + g; O[d + 2] = buf[si + 2] + g;
      O[d + 3] = buf[si + 3];
    }
  };
  for (let y = 0; y < AH; y++) {
    if (y < 630) {
      const cr = cutR(y);
      copy(y, 0, CUT_L, 0);
      copy(y, CUT_L, cr, CUT_L + gl);
      copy(y, cr, AW, cr + insW);
      if (y < TOP_FILL_ROWS) {
        putGrain(A, (y * AW + CUT_L) * 4, y, CUT_L, gl, HD_BEAM_L, aux); // extrude cut column
        putGrain(A, (y * AW + cr) * 4, y, cr + gl, gr, HD_BEAM_R, aux); // extrude cut-line pixel
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
          // grooves/undersides stay UNdrifted — a long groove IS uniform
          put(S, (y * AW + m.fc!) * 4, y, cx, insW);
        } else {
          for (let r = 0; r < insW; r++) {
            const sx = m.s0 + ((cx - m.s0 + r) % m.p);
            const si = (y * AW + sx) * 4;
            const d = (y * w0 + cx + r) * 4;
            const g = m.hd && S[si + 3] > 0 ? hGrainAt(m.hd, src, y, r) : 0; // planks get own-face fiber; rail B's 100px unit has its own grain
            O[d] = S[si] + g; O[d + 1] = S[si + 1] + g; O[d + 2] = S[si + 2] + g;
            O[d + 3] = S[si + 3];
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
  // g1 repeats the seamless cut row + donor fiber (cross = the column, so
  // fibers run DOWN the rails — along the wood, not across it). Cross is
  // LOCAL to each rail: an absolute x would mirror-wrap inside the right
  // rail and stamp a reflected fiber copy there ("tile drawn twice").
  for (let r = 0; r < g1; r++) {
    row(VCUT1, dy);
    const base = dy * w0 * 4;
    for (let x = 0; x < w0; x++) {
      const d = base + x * 4;
      if (O[d + 3] > 0) {
        const cross = x >= w0 - 64 ? x - (w0 - 64) : x;
        const g = vGrainAt(VD_GAME, cross, r);
        if (g) { O[d] += g; O[d + 1] += g; O[d + 2] += g; }
      }
    }
    dy++;
  }
  for (let y = VCUT1; y < VCUT2.y; y++) row(y, dy++);
  for (let r = 0; r < g2; r++) row(VCUT2.s0 + ((VCUT2.y - VCUT2.s0 + r) % VCUT2.p), dy++);
  for (let y = VCUT2.y; y < AH; y++) row(y, dy++);
  return out;
}

const GAME_FRAC = 0.618; // golden ratio (maintainer: rail A at the golden split)

function splitInsH(insH: number, h0: number): [number, number] {
  // Place the game/HUD border (rail A's solid band) at the GOLDEN RATIO of
  // the viewport height (maintainer). gameHeight = (RAIL_SOLID_Y + g1)*s and
  // viewport = h0*s, so for gameHeight/viewport = GAME_FRAC:
  //   g1 = GAME_FRAC*h0 - RAIL_SOLID_Y.
  // The remainder stretches the PAGE window (VCUT2 bark unit, g2) — so the
  // bigger HUD region gives the x2 slots/buttons their room.
  const g1 = Math.max(0, Math.min(insH, Math.round(GAME_FRAC * h0 - RAIL_SOLID_Y)));
  return [g1, insH - g1];
}

// EXPERIMENT (maintainer 2026-07-17): render the whole page frame + its HUD
// at "1x" instead of the current "2x"-feel. HUD_SCALE multiplies the frame's
// render scale (thinner rails, smaller tab/page windows) and hud.ts reads
// the SAME factor via --ml-hud-scale to shrink the plates in lockstep so
// they keep filling the (now smaller) windows. 1 = today's look; 0.5 = half.
// Rollback = set back to 1 (or revert the commit).
export const HUD_SCALE = 0.75;

function compose() {
  if (!canvas || !frameData || !auxData) return;
  const wCss = window.innerWidth;
  const hCss = window.innerHeight;
  const s = Math.min(wCss / AW, hCss / AH) * HUD_SCALE;
  const w0 = Math.max(AW, Math.round(wCss / s));
  const h0 = Math.max(AH, Math.round(hCss / s));
  const [g1, g2] = splitInsH(h0 - AH, h0);
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

// ---- character-select BORDER v3 -------------------------------------------
// The maintainer's vine-wrapped border (2026-07-18, /ui2/select-frame.png:
// his 768x1376 magenta-keyed art — keyed, sparkle dropped, soft edges) is
// composed EXACTLY like the in-game frame: stretch cuts through plain wood
// insert pixels on both axes (single-slice extrusion + own-face fiber — the
// full grain treatment), and the result renders at the SAME "1.5x" scale as
// the in-game frame: sv = min(vw/768, vh/1376) * HUD_SCALE in the overlay's
// virtual px, which lands on the identical real-px-per-art-px factor once
// the uiZoom multiplies in. Replaces the piece-based select2 ring.

// measured off the keyed art (2026-07-18 scans):
const SEL_CUT = { top: 300, bot: 285, interior: 384, midRow: 890 };
const SEL_BAND = { top: 200, bot: 1200 }; // rows above/below use the beam cuts
const SEL_INNER = { left: 91, right: 687, top: 94, bottom: 1319 };
const HD_SEL_TOP: HDonor = { aux: false, x0: 263, x1: 344, y0: 16, y1: 96 };
const HD_SEL_BOT: HDonor = { aux: false, x0: 249, x1: 322, y0: 1318, y1: 1376 };
const SEL_RAIL_R = 72; // right rail width: local fiber cross = x - (w0 - 72)

let selCanvas: HTMLCanvasElement | null = null;
let selParent: HTMLElement | null = null;
let selFrameData: ImageData | null = null;

function composeSelect() {
  if (!selCanvas || !selParent || !selFrameData || !selCanvas.isConnected) return;
  const vw = selParent.clientWidth; // virtual px (inside the uiZoom)
  const vh = selParent.clientHeight;
  if (!vw || !vh) return;
  const sv = Math.min(vw / AW, vh / AH) * HUD_SCALE;
  const w0 = Math.ceil(vw / sv);
  const h0 = Math.ceil(vh / sv);
  const insW = w0 - AW;
  const insH = h0 - AH;
  const S = selFrameData.data;
  // widen: one cut per band — through the top/bottom beam's plain wood, or
  // through the transparent interior for the middle rows
  const wide = new Uint8ClampedArray(w0 * AH * 4);
  for (let y = 0; y < AH; y++) {
    const inTop = y < SEL_BAND.top;
    const inBot = y >= SEL_BAND.bot;
    const cut = inTop ? SEL_CUT.top : inBot ? SEL_CUT.bot : SEL_CUT.interior;
    wide.set(S.subarray(y * AW * 4, (y * AW + cut) * 4), y * w0 * 4);
    wide.set(S.subarray((y * AW + cut) * 4, (y + 1) * AW * 4), (y * w0 + cut + insW) * 4);
    const si = (y * AW + cut) * 4;
    if (S[si + 3] > 0) {
      const hd = inTop ? HD_SEL_TOP : HD_SEL_BOT;
      for (let r = 0; r < insW; r++) {
        const g = hGrainAt(hd, selFrameData, y, r);
        const d = (y * w0 + cut + r) * 4;
        wide[d] = S[si] + g; wide[d + 1] = S[si + 1] + g; wide[d + 2] = S[si + 2] + g;
        wide[d + 3] = S[si + 3];
      }
    }
  }
  // heighten: repeat the plain rail row + fiber (per-rail local cross)
  const out = new ImageData(w0, h0);
  const O = out.data;
  let dy = 0;
  const row = (sy: number) => {
    O.set(wide.subarray(sy * w0 * 4, (sy + 1) * w0 * 4), dy * w0 * 4);
    dy++;
  };
  for (let y = 0; y < SEL_CUT.midRow; y++) row(y);
  for (let r = 0; r < insH; r++) {
    row(SEL_CUT.midRow);
    const base = (dy - 1) * w0 * 4;
    for (let x = 0; x < w0; x++) {
      const d = base + x * 4;
      if (O[d + 3] > 0) {
        const cross = x >= w0 - SEL_RAIL_R ? x - (w0 - SEL_RAIL_R) : x;
        const g = vGrainAt(VD_SEL, cross, r);
        if (g) { O[d] += g; O[d + 1] += g; O[d + 2] += g; }
      }
    }
  }
  for (let y = SEL_CUT.midRow; y < AH; y++) row(y);
  selCanvas.width = w0;
  selCanvas.height = h0;
  selCanvas.style.width = `${vw}px`;
  selCanvas.style.height = `${vh}px`;
  selCanvas.getContext("2d")!.putImageData(out, 0, 0);
  // content stays inside the border's inner window (virtual px)
  const pad = (v: number) => `${Math.round(v * sv) + 4}px`;
  selParent.style.padding =
    `${pad(SEL_INNER.top)} ${pad(AW - SEL_INNER.right)} ` +
    `${pad(AH - SEL_INNER.bottom)} ${pad(SEL_INNER.left)}`;
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
  if (selFrameData) {
    composeSelect();
  } else {
    loadImageData("/ui2/select-frame.png").then((d) => {
      selFrameData = d;
      buildVDonor(VD_SEL, d);
      buildHDonor(HD_SEL_TOP, d);
      buildHDonor(HD_SEL_BOT, d);
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
      buildVDonor(VD_GAME, f);
      buildHDonor(HD_BEAM_L, a);
      buildHDonor(HD_BEAM_R, a);
      buildHDonor(HD_RAIL_A, f);
      buildHDonor(HD_BOTTOM, f);
      compose();
    });
  } else {
    compose();
  }
}

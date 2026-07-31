/**
 * Time-of-day PILL — "Fern starfall" (maintainer-chosen, 2026-07-30, after a
 * long design round: papercut family, Fern's palette, Sea glass's plain disc
 * sun, Storm's starfield + falling star).
 *
 * REAL PIXEL ART, not CSS: a 40×12 art-pixel scene painted into an ImageData
 * buffer and shown at ×2 (80×32 css px) with nearest-neighbour scaling, so the
 * pixel grid is exact. Flat cut-paper layers, hard edges, no dithering and no
 * gradients anywhere.
 *
 * THE MOTION — and why the old hand-off machinery is GONE. The sun crosses
 * left→right and sets behind the hills on the right; the moon rises from the
 * left at that same instant and makes the same trip. Each body is drawn THREE
 * times, one pill-width apart, so the copy leaving the right edge and the copy
 * entering the left are one continuous belt: there is no discontinuity to hide.
 * The old dial had to jump the hand 180° at each boundary and the SERVER froze
 * the world clock for 1.25s while it glided (WorldRoom.handoffHoldMs) — all of
 * that is deleted. This pill is a pure function of the cycle position, so it
 * cannot drift, cannot need a freeze, and resumes correctly from any state.
 *
 * Input is (f, night) straight from WorldScene's handAngle(): f is the
 * fraction through the current sweep, night says which body leads. The pill's
 * own cycle position is u = night ? 0.5 + f/2 : f/2 — which puts the sun's
 * apex at the middle of the sunlit span (= Day's midpoint), the moon's apex at
 * Night's midpoint, and the horizon crossings exactly at the game's sunrise and
 * sunset, where the directional sun's strength ramps through zero.
 */

// GEOMETRY IS THE APPROVED MOCK'S, VERBATIM (papercut variant 21). Every
// number here was signed off by eye at x2 — a first cut squeezed the scene
// into 12 rows with r=2.8 orbs and no glow, and the maintainer caught it
// immediately: "your sun and moon look more squary". A 2.8 disc is 5x5 with
// barely-nicked corners; 3.4 is the 7x7 with real round shoulders, and the
// glow melts its remaining corners into the sky. Don't re-tune these to save
// a few pixels of screen — shrink SCALE instead.
const AW = 40; // art pixels across
const AH = 16; // art pixels down
const SCALE = 2; // 1 art px = 2 css px
const HOR = 10; // horizon row: where the orbs cross the hills
const AMP = 7; // arc height in art px
const R = 3.4; // sun/moon radius

type RGB = [number, number, number];
const hx = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const mix = (a: RGB, b: RGB, t: number): RGB =>
  [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;
const shade = (c: RGB, t: number): RGB => mix(c, [0, 0, 0], t);

// Palette keys at sunrise (u 0) · noon (.25) · sunset (.5) · midnight (.75).
// Each row is [sky, hill 1, hill 2, hill 3] — Fern's greens.
const KEYS: RGB[][] = [
  ["#f2e2c8", "#c8d8a0", "#8aa878", "#4a6a52"].map(hx),
  ["#e6f4dc", "#b4dda0", "#74b06a", "#3c6f48"].map(hx),
  ["#f0c8a0", "#c8a070", "#7a8058", "#3a4a3c"].map(hx),
  ["#101c18", "#172a22", "#20382c", "#2b4a38"].map(hx),
];
const SUN_C = hx("#ffe08a"); // Sea glass's plain disc
const SUN_A = hx("#e8a850");
const MOON_C = hx("#f6f2e4"); // Fern's full moon
const MOON_A = hx("#cfc6b0");
const STAR_C = hx("#f0f8f4"); // Storm's starfield
// Fixed scatter — a starfield must not shimmer at random every repaint.
const SPOTS: [number, number][] = [
  [3, 2], [9, 1], [15, 3], [22, 1], [28, 4], [34, 2],
];
// Three paper planes: the first cut as peaks, the others as gentle waves.
const LAYERS = [
  { b: 10, a: 1.6, f: 0.24, o: 0, peak: true },
  { b: 12, a: 1.2, f: 0.19, o: 2, peak: false },
  { b: 14, a: 0.8, f: 0.22, o: 4, peak: false },
];

let root: HTMLDivElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let img: ImageData | null = null;
let lastU = 0;
let starUntil = 0; // clockStar(): a transient extra streak

function palAt(u: number): RGB[] {
  const i = Math.floor(u / 0.25) % 4;
  const t = (u - i * 0.25) / 0.25;
  const A = KEYS[i];
  const B = KEYS[(i + 1) % 4];
  return A.map((c, k) => mix(c, B[k], t));
}
/** 0 at full day, 1 at midnight — drives the stars' presence. */
const nightness = (u: number) =>
  Math.max(0, Math.min(1, (Math.cos((u - 0.75) * 2 * Math.PI) + 0.25) / 1.25));

function px(x: number, y: number, c: RGB, a = 255) {
  x |= 0;
  y |= 0;
  if (!img || x < 0 || y < 0 || x >= AW || y >= AH) return;
  const i = (y * AW + x) * 4;
  const d = img.data;
  if (a >= 255) {
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = 255;
    return;
  }
  const k = a / 255;
  d[i] = d[i] * (1 - k) + c[0] * k;
  d[i + 1] = d[i + 1] * (1 - k) + c[1] * k;
  d[i + 2] = d[i + 2] * (1 - k) + c[2] * k;
  d[i + 3] = 255;
}
function disc(cx: number, cy: number, r: number, c: RGB) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r + r * 0.4) px(x, y, c);
    }
}
function ring(cx: number, cy: number, r: number, c: RGB) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const q = (x - cx) ** 2 + (y - cy) ** 2;
      if (q > r * r + r * 0.4 && q <= (r + 1) * (r + 1) + r * 0.4) px(x, y, c);
    }
}
/** A soft radial halo, quadratic falloff — this is what keeps the sun from
 * reading as a block: its corner pixels dissolve into the sky instead of
 * ending on a hard step. Daylight-scaled, so a setting sun loses its glow. */
function glow(cx: number, cy: number, r: number, c: RGB, s: number) {
  for (let y = Math.max(0, (cy - r) | 0); y <= Math.min(AH - 1, cy + r); y++)
    for (let x = Math.max(0, (cx - r) | 0); x <= Math.min(AW - 1, cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      px(x, y, c, (s * (1 - d / r) ** 2) | 0);
    }
}
/** Sun and moon share a size; the moon carries craters so the two never read
 * as the same shape even at a glance. */
function sun(cx: number, cy: number, day: number) {
  glow(cx, cy, 8, SUN_C, 95 * day);
  disc(cx, cy, R, SUN_C);
  ring(cx, cy, R, SUN_A);
}
function moon(cx: number, cy: number) {
  disc(cx, cy, R, MOON_C);
  px(cx - 1, cy - 1, MOON_A);
  px(cx + 1, cy + 1, MOON_A);
  px(cx + 1, cy - 2, MOON_A);
  px(cx - 2, cy + 1, MOON_A);
}

/** The belt: the leading body plus the other one a width behind AND ahead, so
 * an exit on the right is always the same motion as an entry on the left. */
function bodies(u: number): [number, boolean][] {
  const half = Math.floor(u * 2) % 2; // 0 = sun leads, 1 = moon leads
  const cx = ((u * 2) % 1) * AW;
  const leadSun = half === 0;
  return [
    [cx, leadSun],
    [cx - AW, !leadSun],
    [cx + AW, !leadSun],
  ];
}

function paint(u: number) {
  if (!img || !ctx) return;
  const pal = palAt(u);
  const n = nightness(u);
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) px(x, y, pal[0]);

  // stars + Storm's falling star (deterministic in u — no per-frame randomness)
  if (n > 0.05) {
    for (const [x, y] of SPOTS) px(x, y, STAR_C, (n * 200) | 0);
    const ph = (u * 4) % 1;
    if (n > 0.5 && ph < 0.22) streak(6 + ph * 90, 1 + ph * 22, n);
  }
  if (performance.now() < starUntil) {
    // the HUD echo of a world shooting star — one extra streak, any time of day
    const k = 1 - (starUntil - performance.now()) / 900;
    streak(4 + k * 34, 1 + k * 7, 1);
  }

  // sun and moon arc over the horizon; the hills are drawn after, so a body
  // outside the pill sits BELOW the horizon and is hidden — it really sets
  for (const [x, isSun] of bodies(u)) {
    const X = Math.round(x);
    const Y = Math.round(HOR - Math.sin(Math.PI * (x / AW)) * AMP);
    if (isSun) sun(X, Y, 1 - n);
    else moon(X, Y);
  }

  // three cut-paper planes with a hard darker edge along every cut
  LAYERS.forEach((L, i) => {
    const c = pal[i + 1];
    const edge = shade(c, 0.3);
    for (let x = 0; x < AW; x++) {
      let h: number;
      if (L.peak) {
        const t = ((x * L.f + L.o) / Math.PI) % 2;
        h = L.b + Math.round(((t < 1 ? t : 2 - t) * 2 - 1) * L.a);
      } else {
        h = L.b + Math.round(Math.sin(x * L.f + L.o) * L.a);
      }
      for (let y = Math.max(0, h); y < AH; y++) px(x, y, y === h ? edge : c);
    }
  });
  ctx.putImageData(img, 0, 0);
}
function streak(sx: number, sy: number, n: number) {
  for (let k = 0; k < 4; k++)
    px(Math.round(sx - k * 1.6), Math.round(sy - k * 0.5), STAR_C, (n * (230 - k * 55)) | 0);
}

function mount() {
  if (root) return;
  const style = document.createElement("style");
  style.textContent = `
  /* BOTTOM-RIGHT of the GAME VIEW (maintainer 2026-07-31), 10px from the
     right edge — the same margin the XP chip keeps at the top — and 10px
     above the HUD rail. --hud-h is real px, published by hud.ts applyLayout;
     the fallback is the golden-ratio split it computes. */
  .ml-clock{position:fixed;right:10px;bottom:calc(var(--hud-h, 38.2dvh) + 10px);z-index:8;
    width:${AW * SCALE}px;height:${AH * SCALE}px;border-radius:7px;overflow:hidden;
    pointer-events:none;box-sizing:content-box;
    border:1px solid var(--border-strong);box-shadow:var(--shadow)}
  .ml-clock canvas{display:block;width:100%;height:100%;image-rendering:pixelated}`;
  document.head.appendChild(style);
  root = document.createElement("div");
  root.className = "ml-clock";
  const cv = document.createElement("canvas");
  cv.width = AW;
  cv.height = AH;
  root.appendChild(cv);
  document.body.appendChild(root);
  ctx = cv.getContext("2d");
  img = ctx?.createImageData(AW, AH) ?? null;
  paint(lastU);
}

/** A tiny star falls across the pill — the HUD echo of a shooting star in the
 * world (player arrivals + the wild night stars). */
export function clockStar() {
  mount();
  starUntil = performance.now() + 900;
  paint(lastU);
}

/** Drive the pill from the world clock. `f` is the fraction through the
 * current sweep and `night` says which body leads — both straight from
 * WorldScene's handAngle(), so the pill, the directional sun and the ambient
 * can never disagree. There is no instant/animated distinction any more: the
 * art is a pure function of the cycle position, so a join, a phase skip and a
 * per-frame tick are all just "paint this u". */
export function setClockTime(f: number, night: boolean) {
  mount();
  const u = night ? 0.5 + f * 0.5 : f * 0.5;
  lastU = ((u % 1) + 1) % 1;
  paint(lastU);
}

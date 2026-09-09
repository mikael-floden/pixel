/**
 * Time-of-day PILL — "Fern starfall" (maintainer-chosen, 2026-07-30, after a
 * long design round: papercut family, Fern's palette, Sea glass's plain disc
 * sun, Storm's starfield + falling star).
 *
 * REAL PIXEL ART, not CSS: a 40×16 art-pixel scene painted into an ImageData
 * buffer and shown at ×2 (80×32 css px) with nearest-neighbour scaling, so the
 * pixel grid is exact. Flat cut-paper layers, hard edges, no dithering and no
 * gradients anywhere.
 *
 * THE SKY HAS TWO BODIES, NOT ONE BELT (maintainer 2026-07-31, and it is the
 * whole design). The first cut alternated a single travelling orb: the sun
 * crossed on morning+day+evening, the moon crossed on night, and since those
 * spans differ the moon visibly RACED. The fix is the real world's: the sun
 * and the moon are two different objects, and both can be in the sky at once.
 *
 *   tau (0 at sunrise, 1 a full day later)
 *   0        1/6                 1/2        2/3                      1
 *   |morning |        day        | evening  |         night          |
 *   sun  ├──────────── crossing ────────────┤              (below)
 *   moon ─── crossing ┤              (below)├──── crossing ──────────
 *
 * Each body crosses the pill in exactly 2/3 of a day — the sun over
 * morning+day+evening, the moon over evening+night+morning — so they move at
 * THE SAME SPEED, and they overlap at both ends: the moon rises the moment the
 * sun enters evening ("preparing for night") and lingers through the morning
 * while the sun climbs ("preparing for day"). The sun stays the main actor: it
 * is drawn last, it carries the glow, and the daylit moon is pale with a rim,
 * the way you actually see it at dawn. Equal spans require DAY == NIGHT in
 * TIME_PHASE_SECONDS — see the note there before touching the durations.
 *
 * Nothing ever teleports: each body enters and leaves at the horizon, BEHIND
 * the hills (they are painted last), and its position is a continuous function
 * of tau across the whole cycle including the wrap. There is no hand-off to
 * animate, which is why the SERVER's old freeze (WorldRoom.handoffHoldMs, a
 * 1.25s stop of the world clock at each day/night boundary) could be deleted.
 *
 * Input is the world clock's own continuous position, timeIdx + phaseT.
 */
import { TIME_PHASE_SECONDS } from "@nangijala/shared";

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

// ── the day, in fractions of the whole cycle ─────────────────────────────
// tau runs 0..1 from SUNRISE (the start of morning). Everything below is
// derived from TIME_PHASE_SECONDS, so changing the durations moves the whole
// scene consistently — but see the equal-speed note there.
const SECS = TIME_PHASE_SECONDS; // [night, morning, day, evening]
const TOTAL = SECS[0] + SECS[1] + SECS[2] + SECS[3];
const T_EVENING = (SECS[1] + SECS[2]) / TOTAL; // day ends / evening begins
const T_NIGHT = (SECS[1] + SECS[2] + SECS[3]) / TOTAL; // sunset
const SUN_START = 0;
const SUN_SPAN = T_NIGHT; // morning + day + evening
const MOON_START = T_EVENING;
const MOON_SPAN = (SECS[3] + SECS[0] + SECS[1]) / TOTAL; // evening + night + morning
// Palette anchors in tau: sunrise, noon (mid-day), sunset, midnight (mid-night).
const ANCHORS = [0, (SECS[1] + SECS[2] / 2) / TOTAL, T_NIGHT, T_NIGHT + SECS[0] / 2 / TOTAL];

// Palette keys at sunrise · noon · sunset · midnight.
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
let lastTau = 0;
let starUntil = 0; // clockStar(): a transient extra streak

/** The sky between its four anchors. They are NOT evenly spaced any more
 * (sunset and midnight are only half a night apart), so this walks the real
 * anchor list instead of assuming quarters. */
function palAt(tau: number): RGB[] {
  let i = 3;
  for (let k = 3; k >= 0; k--) if (tau >= ANCHORS[k]) { i = k; break; }
  const a = ANCHORS[i];
  const b = i === 3 ? ANCHORS[0] + 1 : ANCHORS[i + 1];
  const t = (tau - a) / (b - a);
  return KEYS[i].map((c, k) => mix(c, KEYS[(i + 1) % 4][k], t));
}
/** 0 through the day, 1 at midnight — drives the stars and the moon's
 * daylight paleness. Zero at both ends of the sunlit span (day starts and
 * evening starts), so stars only ever belong to dusk, night and dawn. */
const nightness = (tau: number) =>
  Math.max(0, Math.min(1, (Math.cos((tau - ANCHORS[3]) * 2 * Math.PI) + 0.25) / 1.25));

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
function ring(cx: number, cy: number, r: number, c: RGB, a = 255) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const q = (x - cx) ** 2 + (y - cy) ** 2;
      if (q > r * r + r * 0.4 && q <= (r + 1) * (r + 1) + r * 0.4) px(x, y, c, a);
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
/** In daylight the moon washes toward the sky and picks up a rim — pale, but
 * still legible, which is exactly how a morning moon looks. At night `day` is
 * 0 and this is the approved mock's flat cream disc, untouched. */
function moon(cx: number, cy: number, day: number, sky: RGB) {
  // A light wash only: the RIM is what makes it read as a daytime moon, and
  // washing harder both hid it against a bright sky and drifted its colour far
  // enough from MOON_C to lose the QA detector.
  disc(cx, cy, R, mix(MOON_C, sky, 0.15 * day));
  ring(cx, cy, R, MOON_A, (255 * day) | 0);
  px(cx - 1, cy - 1, MOON_A);
  px(cx + 1, cy + 1, MOON_A);
  px(cx + 1, cy - 2, MOON_A);
  px(cx - 2, cy + 1, MOON_A);
}

/** Where a body sits on ITS OWN crossing: 0 = rising at the left edge, 1 =
 * setting at the right. Values a little outside [0,1] are deliberately kept —
 * that is the body still sliding down behind the hills, or not yet up. The
 * far side of the cycle is folded to NEGATIVE so the approach is continuous
 * too; the fold happens while the body is far off-canvas, so it can never
 * pop. */
function crossing(tau: number, start: number, span: number): number {
  let d = (((tau - start) % 1) + 1) % 1;
  if (d > (span + 1) / 2) d -= 1;
  return d / span;
}
/** The pill's only motion rule: place a body on the arc at its crossing
 * position. Off-pill positions are skipped once even the glow can't reach. */
function place(pos: number, draw: (x: number, y: number) => void) {
  if (pos < -0.3 || pos > 1.3) return;
  draw(Math.round(pos * AW), Math.round(HOR - Math.sin(Math.PI * pos) * AMP));
}

function paint(tau: number) {
  if (!img || !ctx) return;
  const pal = palAt(tau);
  const n = nightness(tau);
  const day = 1 - n;
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) px(x, y, pal[0]);

  // stars + Storm's falling star (deterministic in tau — no per-frame noise)
  if (n > 0.05) {
    for (const [x, y] of SPOTS) px(x, y, STAR_C, (n * 200) | 0);
    const ph = (tau * 4) % 1;
    if (n > 0.5 && ph < 0.22) streak(6 + ph * 90, 1 + ph * 22, n);
  }
  if (performance.now() < starUntil) {
    // the HUD echo of a world shooting star — one extra streak, any time of day
    const k = 1 - (starUntil - performance.now()) / 900;
    streak(4 + k * 34, 1 + k * 7, 1);
  }

  // Both bodies arc over the horizon on their own crossings; the hills are
  // painted after, so whatever is past an edge sits BELOW the horizon and is
  // hidden — it really sets. The MOON goes down first: the sun is the main
  // actor and draws over it if they ever meet.
  place(crossing(tau, MOON_START, MOON_SPAN), (x, y) => moon(x, y, day, pal[0]));
  place(crossing(tau, SUN_START, SUN_SPAN), (x, y) => sun(x, y, day));

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
     right edge — the same margin the XP chip keeps at the top, and the same
     one the chat keeps on the left — and 10px above the HUD rail. --hud-h is
     real px, published by hud.ts applyLayout; the fallback is the
     golden-ratio split it computes. When a chat box is focused the phone
     keyboard covers this corner, so hud.ts lifts the pill (and the chat log)
     above the floated input via :root.ml-kb-up — hence the transition. */
  .ml-clock{position:fixed;right:calc(var(--gv-right,0px) + 10px);
    bottom:calc(var(--hud-h, 38.2dvh) + 10px + var(--ml-stack-step, 44px));z-index:8;
    width:${AW * SCALE}px;height:${AH * SCALE}px;border-radius:7px;overflow:hidden;
    pointer-events:none;box-sizing:content-box;
    transition:bottom .15s ease-out,right .3s ease;
    border:1px solid var(--border-strong);box-shadow:var(--shadow)}
  /* RIGHT-HANDED LANDSCAPE: the game view's bottom-right corner belongs to
     the thumb stick, so the pill moves UP and parks directly under the XP
     chip instead (maintainer 2026-08-05) — same right margin, so the two
     right edges line up, and a 10px gap below the chip matching every other
     margin. --bars-r-h is the chip's MEASURED height (bars.ts publishes it;
     the fallback only covers the first frame). Left-handed keeps the corner:
     there the stick is bottom-LEFT and the pill is nowhere near it. */
  :root.ml-land:not(.ml-lh) .ml-clock{
    top:calc(var(--bars-r-h, 78px) + 20px);bottom:auto}
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
  paint(lastTau);
}

/** A tiny star falls across the pill — the HUD echo of a shooting star in the
 * world (player arrivals + the wild night stars). */
export function clockStar() {
  mount();
  starUntil = performance.now() + 900;
  paint(lastTau);
}

/** (timeIdx + phaseT) → tau, the fraction of the whole day elapsed since
 * SUNRISE. The world clock counts phases from Night; the sky counts from the
 * moment the sun comes up, so this walks the phase ring starting at Morning
 * and weights each phase by its real duration. */
export function dayFraction(u: number): number {
  const N = SECS.length;
  const idx = ((Math.floor(u) % N) + N) % N;
  const t = u - Math.floor(u);
  let acc = 0;
  for (let k = 1; k <= N; k++) {
    const i = k % N; // morning, day, evening, night
    if (i === idx) break;
    acc += SECS[i];
  }
  return ((acc + t * SECS[idx]) / TOTAL) % 1;
}

/** Drive the pill from the world clock: `u` is timeIdx + phaseT, exactly the
 * value the ambient and the directional sun are derived from, so the three can
 * never disagree. There is no instant/animated distinction: the art is a pure
 * function of the cycle position, so a join, a phase skip and a per-frame tick
 * are all just "paint this tau". */
export function setClockTime(u: number) {
  mount();
  lastTau = dayFraction(u);
  paint(lastTau);
}

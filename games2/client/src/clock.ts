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
// AW IS THE WIDTH THE MOCK WAS APPROVED AT, and `aw` is what is actually
// drawn. The pill grows with the XP card, but only a THIRD as far. It took
// the card's FULL width on the morning of 2026-09-19, then half of the extra
// ("I just feel the pill got a little bit to wide… just extend it 50% that
// additional width instead"), then a third ("that turned out also be to much.
// Now I think you should have extended the pill only 33%"). EXT is that share
// and it is the ONLY thing those three rounds changed: the width was never a
// literal anywhere in this file, it is whatever `aw` says.
// NOTHING IS STRETCHED, and nothing can be: this scene is drawn COLUMN BY
// COLUMN, so a wider pill is more sky and more hill at the SAME 2x pixel size.
// The orbs keep r=3.4 and their glow, the hills keep their wavelength (they are
// sin(x*f+o), so a wider canvas gets MORE of them, not longer ones), and his
// six hand-placed stars keep their exact coordinates — see spotsFor().
const AW = 40; // art pixels across, as approved
let aw = AW; // …and as currently drawn
const EXT = 1 / 3; // …of the card's extra width, in WHOLE art px (see fitPill)
const TOP_CLS = "on-top"; // set by fitPill when the two cards leave room for it
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
/** His six stars are the mock's and never move. A pill wider than the mock
 *  gets more of them BEYOND x=40 at the same density (six over forty columns)
 *  and in the same y band, chosen by a hash of the column so they are fixed
 *  for a given width and can never twinkle or crawl. Memoised because paint()
 *  runs on every frame. */
let spotsCache: { w: number; spots: [number, number][] } = { w: AW, spots: SPOTS };
function spotsFor(w: number): [number, number][] {
  if (spotsCache.w === w) return spotsCache.spots;
  const spots: [number, number][] = SPOTS.filter(([x]) => x < w);
  for (let x = AW; x < w; x++) {
    // FNV-ish on the column: deterministic, and neighbouring columns land in
    // different buckets so the extra stars scatter like the originals.
    const h = ((x * 2654435761) >>> 0) % 1000;
    if (h < 150) spots.push([x, 1 + (h % 4)]); // 6/40 = 15% of columns, y 1..4
  }
  spotsCache = { w, spots };
  return spots;
}
// Three paper planes: the first cut as peaks, the others as gentle waves.
const LAYERS = [
  { b: 10, a: 1.6, f: 0.24, o: 0, peak: true },
  { b: 12, a: 1.2, f: 0.19, o: 2, peak: false },
  { b: 14, a: 0.8, f: 0.22, o: 4, peak: false },
];

let root: HTMLDivElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let img: ImageData | null = null;
let cv: HTMLCanvasElement | null = null; // module-scope so fitPill can rebuild it
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
  if (!img || x < 0 || y < 0 || x >= aw || y >= AH) return;
  const i = (y * aw + x) * 4;
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
    for (let x = Math.max(0, (cx - r) | 0); x <= Math.min(aw - 1, cx + r); x++) {
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
  draw(Math.round(pos * aw), Math.round(HOR - Math.sin(Math.PI * pos) * AMP));
}

function paint(tau: number) {
  if (!img || !ctx) return;
  const pal = palAt(tau);
  const n = nightness(tau);
  const day = 1 - n;
  for (let y = 0; y < AH; y++) for (let x = 0; x < aw; x++) px(x, y, pal[0]);

  // stars + Storm's falling star (deterministic in tau — no per-frame noise)
  if (n > 0.05) {
    for (const [x, y] of spotsFor(aw)) px(x, y, STAR_C, (n * 200) | 0);
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
    for (let x = 0; x < aw; x++) {
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
  /* CENTRED IN THE GAME VIEW, KEEPING ITS OWN TOP MARGIN (maintainer
     2026-09-19: "lets center the pill at the top instead (with same top
     margin)"). It had to move: at half the extension it is no longer the XP
     card's width, so the right edge it used to share with the card and the
     Wiki row lines up with nothing, and a box that is nearly-but-not-quite
     aligned reads as a mistake.
     TOP CENTRE IS THE CARDS' OWN LINE, on their 10px margin — "WHY DID YOU
     PLACE THE time-of-day pill in the center and not TOP center!!!", after a
     first cut put it a third of the way down the screen over the player's
     head. It takes that line WHEN THE TWO CARDS LEAVE ROOM: fitPill measures
     the gap between them and needs the pill plus 10px each side. On his phone
     (495px) that gap is 174 for a 104px pill. At 393px it is 77 and the pill
     would sit on top of an HP bar, so there it keeps the row it had before —
     one --ml-stack-step under the Wiki row, the first row that is free all
     the way across at every width. Two rows, one measurement, no guessing.
     ONE RULE FOR EVERY ORIENTATION AND BOTH HANDS. It used to be three — a
     bottom-right corner at rest plus two top-anchored overrides — because
     the corner it wanted belonged to the thumb stick in landscape and to the
     ghost stick in portrait. The centre of that row belongs to nothing in
     any of them, so the special cases are gone, and with them the keyboard
     lift: nothing down there can reach a box anchored to the top.
     left and width are set from JS (fitPill) rather than calc()ed here,
     because both have to land on WHOLE art pixels — CSS cannot round, and a
     half-pixel box under a pixelated canvas is the smear this whole design
     exists to avoid. What is here is the first-frame fallback. */
  .ml-clock{position:fixed;
    top:calc(var(--ml-safe-top, 0px) + var(--bars-r-h, 78px) + 20px + var(--ml-stack-step, 44px));
    left:calc((100vw - ${AW * SCALE + 2}px) / 2);z-index:8;
    width:${AW * SCALE}px;height:${AH * SCALE}px;border-radius:7px;overflow:hidden;
    pointer-events:none;box-sizing:content-box;
    border:1px solid var(--border-strong);box-shadow:var(--shadow)}
  /* the cards' own line — fitPill adds this class only when they leave room */
  .ml-clock.${TOP_CLS}{top:calc(var(--ml-safe-top, 0px) + 10px)}
  .ml-clock canvas{display:block;width:100%;height:100%;image-rendering:pixelated}`;
  document.head.appendChild(style);
  root = document.createElement("div");
  root.className = "ml-clock";
  cv = document.createElement("canvas");
  cv.width = aw;
  cv.height = AH;
  root.appendChild(cv);
  ctx = cv.getContext("2d");
  img = ctx?.createImageData(aw, AH) ?? null;
  paint(lastTau);
  // sized and centred BEFORE it is in the document: fitPill reads :root vars
  // and the viewport, never this box, so it needs no layout — and the pill is
  // therefore never painted once at the fallback width on its way to the real
  // one.
  fitPill();
  document.body.appendChild(root);
  // the card's width is a media query, so it changes on exactly the events
  // hud.ts re-publishes it on
  window.addEventListener("ml-layout", fitPill);
  window.addEventListener("resize", fitPill);
}

/**
 * THE PILL'S WIDTH AND ITS CENTRE, BOTH IN WHOLE ART PIXELS — the one
 * function that stops this being a stretch.
 *
 * Width: AW plus EXT of whatever the XP card is wider than AW ("extended the
 * pill only 33%"). That extra is rounded to a WHOLE
 * art pixel and the box is then exactly `aw * SCALE` css px, so one art pixel
 * is always exactly SCALE css px and the canvas's backing store can never
 * disagree with its box — a disagreement is precisely the smearing he was
 * afraid of. Doing the same sum in calc() would land on odd css px (146 -> 113)
 * and hand the canvas a 1.98x scale.
 *
 * Centre: rounded to a whole css px for the same reason. A fixed box centred
 * in an odd viewport lands on x.5 otherwise, which shifts the whole nearest-
 * neighbour grid by half a pixel.
 *
 * Reads --bars-r-w / --gv-left / --gv-right off :root (hud.ts publishes all
 * three in applyLayout) rather than its own rect: measuring a box you are
 * about to resize is how you get a feedback loop, and the rect would include
 * the 1px borders this content-box width does not.
 */
function fitPill() {
  if (!root || !cv) return;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, dflt: number) => {
    const n = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(n) ? n : dflt;
  };
  // the card's CONTENT width in art px — --bars-r-w is its border-box rect
  const card = Math.round((v("--bars-r-w", AW * SCALE + 2) - 2) / SCALE);
  const w = Math.max(AW, AW + Math.round((card - AW) * EXT));
  const box = w * SCALE;
  const gl = v("--gv-left", 0);
  const gr = v("--gv-right", 0);
  // +2 for this box's own borders, which sit outside its content-box width
  root.style.left = `${Math.round(gl + (window.innerWidth - gl - gr - box - 2) / 2)}px`;
  root.style.width = `${box}px`;
  // THE TOP ROW IF THE TWO CARDS LEAVE ROOM FOR IT, MEASURED, NOT ASSUMED.
  // "Top center" is the cards' own line and that is where it belongs; the
  // only thing that can stop it is the gap between them, which is the view
  // minus their two margins and their two widths. It needs the pill plus the
  // same 10px margin on each side — anything less and the pill sits on top of
  // an HP bar. Measured on his phone (495px) the gap is 174 for a 104px
  // pill; at 393px it is 77 and the pill drops to the row under the Wiki row,
  // which is free all the way across at every width.
  const free = window.innerWidth - gr - 10 - v("--bars-r-w", 0) - (gl + 10 + v("--bars-l-w", 0));
  root.classList.toggle(TOP_CLS, free >= box + 2 + 20);
  if (w === aw) return;
  aw = w;
  cv.width = aw;
  ctx = cv.getContext("2d");
  img = ctx?.createImageData(aw, AH) ?? null;
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
// QA probe: drive the scene to any point in the cycle without waiting for the
// world clock (the pill's look is reviewed at four times of day).
(window as unknown as { __mlClockProbe?: (u: number) => void }).__mlClockProbe = (u: number) => setClockTime(u);

export function setClockTime(u: number) {
  mount();
  lastTau = dayFraction(u);
  paint(lastTau);
}

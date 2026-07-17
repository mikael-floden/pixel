/**
 * Celestial clock — now ONLY the animated hand (plus the shooting-star echo),
 * hung on the frame's strap stub over the frame's own BAKED zodiac disc.
 *
 * The old sheet-3 sky-disc dials + dot arc (/ui/clock_*.png, cross-faded per
 * phase) are RETIRED (maintainer 2026-07-17: the frame-v2 HUD has a built-in
 * clock — the baked disc — and rendering the dial stack over it read as
 * "double clocks"). setClockPhase stays exported as a no-op so WorldScene's
 * phase listener keeps its contract; the phase look lives in the ambient
 * grade, and the hand angle alone tells the time on the disc.
 *
 * Angle convention (careful — this shipped wrong once): CSS rotate() is
 * clockwise on screen, so rotating a DOWN-pointing hand by a POSITIVE angle
 * sweeps its tip toward screen-LEFT. All angles below are "degrees from
 * straight down, positive = left".
 */

// The maintainer's v2 handle (/ui2/clock-hand.png): vine-wrapped blade WITH
// its own ring, authored pointing DOWN (so baseDeg = 0), at FRAME-art scale
// (45x163 native). Pivot = the ring hole (the maintainer's blue dot); it
// mounts on the frame's strap stub (FrameLayout.clockAnchor), so it is NOT
// uiZoom'd — it lives in the frame's own px space and is sized by the frame
// scale.
const HAND = { w: 45, h: 163, hubX: 23, hubY: 18, baseDeg: 0 };
const FADE_S = 2.5; // keep in step with WorldScene's TIME_TRANSITION_S

// The frame's baked disc, relative to the clock anchor (the strap stub at
// frame art (385,88)): the disc face spans roughly art rows 100..290 centred
// on the strap's x — the star echo orbits inside it.
const DISC = { cx: 0, cy: 78, rMin: 42, rMax: 78 };

let handRoot: HTMLDivElement | null = null;
let hand: HTMLImageElement | null = null;
// Current CSS rotation. Continuous ticks and the mid-phase hand-off jump
// snap; only large forward skips ride the CSS transition.
let handDeg: number | null = null;
// Frame mount for the hand (set by hud.ts after every frame compose):
// anchor in layout px + the frame's css-per-art-px scale.
let mountPt = { x: 0, y: 0, s: 1, has: false };

/** Hang the hand's pivot on the frame's strap stub (called on every frame
 * compose/resize — the anchor moves with the width insert and the scale). */
export function setClockMount(x: number, y: number, s: number) {
  mountPt = { x, y, s, has: true };
  applyMount();
}

function applyMount() {
  if (!hand || !mountPt.has) return;
  const { x, y, s } = mountPt;
  hand.style.width = `${HAND.w * s}px`;
  hand.style.left = `${x - HAND.hubX * s}px`;
  hand.style.top = `${y - HAND.hubY * s}px`;
  hand.style.transformOrigin = `${HAND.hubX * s}px ${HAND.hubY * s}px`;
}

function mount() {
  if (handRoot) return;
  const style = document.createElement("style");
  // the hand layer is a full-viewport plane in FRAME px space (no uiZoom,
  // no centring transform) — the img inside is placed by applyMount. It
  // sits ABOVE the page-frame art (z 7 vs the frame's 6): at the
  // 100%-horizontal night/morning stops the hand lies along the frame rail
  // and would vanish behind it otherwise.
  style.textContent = `
  .ml-clock-hand{position:fixed;inset:0;z-index:7;pointer-events:none}
  .ml-clock-hand img{position:absolute;top:0;left:0;
    opacity:1;image-rendering:pixelated;transition:transform ${FADE_S}s ease}
  .ml-clock-hand.snap img{transition:none}`;
  document.head.appendChild(style);
  handRoot = document.createElement("div");
  handRoot.className = "ml-clock-hand";
  hand = document.createElement("img");
  hand.src = "/ui2/clock-hand.png";
  hand.alt = "";
  hand.draggable = false;
  handRoot.appendChild(hand);
  document.body.appendChild(handRoot);
  applyMount(); // if the frame composed before the first clock call
}

/** A tiny star twinkles across the frame's baked disc — the HUD echo of a
 * shooting star in the world (arrivals + wild night stars). Lives in the
 * hand's frame-px plane and orbits below the strap anchor. */
export function clockStar() {
  mount();
  if (!mountPt.has) return; // no frame yet — nothing to echo on
  const { x, y, s } = mountPt;
  const st = document.createElement("div");
  st.style.cssText =
    "position:absolute;width:2px;height:2px;background:#fff;" +
    "box-shadow:0 0 3px 1px rgba(255,255,240,.9);pointer-events:none";
  handRoot!.appendChild(st);
  const dur = 900;
  const t0 = performance.now();
  const dir = Math.random() < 0.5 ? 1 : -1; // which horizon it falls toward
  const r = (DISC.rMin + Math.random() * (DISC.rMax - DISC.rMin)) * s;
  const cx = x + DISC.cx * s;
  const cy = y + DISC.cy * s;
  const step = (t: number) => {
    const k = (t - t0) / dur;
    if (k >= 1 || !handRoot) {
      st.remove();
      return;
    }
    const a = Math.PI * (dir > 0 ? k : 1 - k); // 0..PI sweeps the semicircle
    st.style.left = `${cx - Math.cos(a) * r}px`;
    st.style.top = `${cy + Math.sin(a) * r * 0.5}px`;
    st.style.opacity = String(Math.sin(Math.PI * k));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** RETIRED no-op (the dial stack is gone — the frame's baked disc is the
 * clock face). Kept so WorldScene's phase listener contract is unchanged;
 * still mounts the hand so joining mid-phase shows it immediately. */
export function setClockPhase(_idx: number, _instant = false) {
  mount();
}

/** Point the hand at an absolute angle (degrees from straight down,
 * positive = screen-left) — WorldScene computes it from the duration-
 * weighted sweeps and the SUN derives from the same angle, so the arrow
 * and the directional light can never disagree (maintainer). The hand-off
 * jump and continuous ticks SNAP; forward skips (freeze-mode phase
 * testing) ride the CSS transition. */
export function setClockAngle(deg: number, instant = false) {
  mount();
  const target = deg - HAND.baseDeg;
  if (handDeg !== null && Math.abs(target - handDeg) < 0.01) return;
  const delta = handDeg === null ? 0 : target - handDeg;
  const snap = instant || handDeg === null || delta < 3; // backwards = the hand-off jump
  if (snap) handRoot!.classList.add("snap");
  handDeg = target;
  hand!.style.transform = `rotate(${handDeg}deg)`;
  if (snap) {
    handRoot!.offsetWidth;
    handRoot!.classList.remove("snap");
  }
}

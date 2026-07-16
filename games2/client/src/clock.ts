/**
 * Celestial clock — the time-of-day indicator hung top-centre of the game
 * view. Four pre-keyed dials (client/public/ui/clock_<phase>.png, built by
 * scripts/build-clock.mjs from the maintainer's mocks, pixel-aligned to each
 * other) are stacked and cross-faded on the same 2.5s clock as the ambient
 * grade. Order matches WorldScene's TIME_PHASES / shared timeIdx.
 *
 * Small footprint, FULL detail (maintainer round 9 — the coarse-grid
 * experiment turned the dial to mud; we aim for the top): assets bake at
 * exactly the display resolution with hard pixel-stair edges and a baked
 * border ring at the frame's border weight, rendered 1 asset px = 1 CSS px
 * + pixelated so the browser never resamples.
 *
 * Angle convention (careful — this shipped wrong once): CSS rotate() is
 * clockwise on screen, so rotating a DOWN-pointing hand by a POSITIVE angle
 * sweeps its tip toward screen-LEFT. All angles below are "degrees from
 * straight down, positive = left".
 */
import { applyUiZoom } from "./uiscale";

const PHASE_FILES = ["night", "morning", "day", "evening"] as const;
const FADE_S = 2.5; // keep in step with WorldScene's TIME_TRANSITION_S

// The hand reads the half-dial as a 12-HOUR face crossed TWICE per game
// day (maintainer's green/morning + red/evening wedges): the DAY sweep runs
// morning-mid -> evening-mid (-90 right horizon .. +90 left horizon, "12"
// straight down at day-mid) and the NIGHT sweep runs evening-mid ->
// morning-mid the same way ("12" at night-mid). At each hand-off — 50%
// through evening and 50% through morning, having reached 100% left — the
// hand JUMPS immediately back to 100% right (maintainer). It never leaves
// the dial face (the old over-the-top night sweep poked into the sky).

// Asset geometry, measured/printed by scripts/build-clock.mjs. Everything
// renders at 1 asset px = 1 CSS px. Sheet-3 dials are the half-moon sky
// discs cut just BELOW the frame rail (flat edge at the top, mock gem tip
// notched out — the frame's real gem covers that spot), so the pivot is
// the semicircle's centre: the middle of the asset's top edge.
// 1.5x the first bake — full mock res (2x) read "a bit too big"
// (maintainer); assets are area-average baked to 3/4 mock size and render
// 1:1 + pixelated (nearest-neighbour rule — the browser never resamples).
const DIAL = { w: 168, h: 99, knobX: 84, knobY: 0 }; // incl. baked border-ring margin
const ROOT_W = DIAL.w;
// Sheet-3 hand points RIGHT as authored (hub = the sun-face disc, left end).
const HAND = { w: 81, h: 19, hubX: 11.2, hubY: 9.3, baseDeg: -90.8 };
// The floating dot arc around the dial is its OWN static layer (maintainer:
// the dots must never fade with the phase cross-fades). Axis-centred like
// the dials, top row = the same rail-bottom line.
const DOTS = { w: 174, h: 99 };

let root: HTMLDivElement | null = null;
// The hand lives in its OWN fixed layer ABOVE the page-frame art (z 7 vs
// the frame's 6, dials at 5): at the 100%-horizontal night/morning stops
// it lies along the frame rail and would vanish behind it otherwise — on
// top it reads as resting on the rail, and the over-the-top CW sweep
// stays visible.
let handRoot: HTMLDivElement | null = null;
let dials: HTMLImageElement[] = [];
let hand: HTMLImageElement | null = null;
// Current CSS rotation. Continuous ticks and the mid-phase hand-off jump
// snap; only large forward skips ride the CSS transition.
let handDeg: number | null = null;

function mount() {
  if (root) return;
  const style = document.createElement("style");
  // top: the dial's flat edge tucks under the FRAME's rail. The frame is
  // NOT uiZoom'd (its art is fixed layout px) while the clock IS — under
  // desktop-site layout (maintainer's phone: ~980px layout on a ~393px
  // screen, zoom ~2.5) a plain top:33px rendered 33*zoom layout px and the
  // dial floated ~20px BELOW the rail ("big gap, not connected to the
  // frame"). Dividing by --ml-uizoom cancels the zoom for the anchor only,
  // so the dial meets the rail in EVERY layout mode.
  style.textContent = `
  .ml-clock,.ml-clock-hand,.ml-clock-dots{position:fixed;
    top:calc(33px / var(--ml-uizoom, 1));left:50%;
    transform:translateX(-50%);width:${ROOT_W}px;pointer-events:none}
  .ml-clock{z-index:5}
  .ml-clock-dots{z-index:5;width:${DOTS.w}px}
  .ml-clock-hand{z-index:7}
  .ml-clock img,.ml-clock-hand img{position:absolute;top:0;left:0;width:100%;
    opacity:0;image-rendering:pixelated;transition:opacity ${FADE_S}s ease}
  .ml-clock-dots img{position:absolute;top:0;left:0;width:100%;
    image-rendering:pixelated}
  .ml-clock img.on{opacity:1}
  .ml-clock-hand img{opacity:1;transition:transform ${FADE_S}s ease}
  .ml-clock.snap img,.ml-clock-hand.snap img{transition:none}`;
  document.head.appendChild(style);
  // Static dot arc UNDER the dial stack in the same plane — mounted first,
  // constant forever (no phase class, no transition: it must not blink).
  const dotsRoot = document.createElement("div");
  dotsRoot.className = "ml-clock-dots";
  const dotsImg = document.createElement("img");
  dotsImg.src = "/ui/clock_dots.png";
  dotsImg.alt = "";
  dotsImg.draggable = false;
  dotsRoot.appendChild(dotsImg);
  document.body.appendChild(dotsRoot);
  applyUiZoom(dotsRoot);
  root = document.createElement("div");
  root.className = "ml-clock";
  dials = PHASE_FILES.map((p) => {
    const img = document.createElement("img");
    img.src = `/ui/clock_${p}.png`;
    img.alt = "";
    img.draggable = false;
    root!.appendChild(img);
    return img;
  });
  // The hand mounts with its hub centred on the dial's knob and rotates
  // about that point.
  handRoot = document.createElement("div");
  handRoot.className = "ml-clock-hand";
  hand = document.createElement("img");
  hand.src = "/ui/clock_hand.png";
  hand.alt = "";
  hand.draggable = false;
  hand.style.width = `${HAND.w}px`;
  hand.style.left = `${DIAL.knobX - HAND.hubX}px`;
  hand.style.top = `${DIAL.knobY - HAND.hubY}px`;
  hand.style.transformOrigin = `${HAND.hubX}px ${HAND.hubY}px`;
  handRoot.appendChild(hand);
  document.body.appendChild(root);
  document.body.appendChild(handRoot);
  applyUiZoom(root);
  applyUiZoom(handRoot);
}

/** A tiny star twinkles across the dial's sky — the HUD echo of a shooting
 * star in the world (arrivals + wild night stars). */
export function clockStar() {
  if (!root) return;
  const s = document.createElement("div");
  s.style.cssText =
    "position:absolute;width:2px;height:2px;background:#fff;" +
    "box-shadow:0 0 3px 1px rgba(255,255,240,.9);pointer-events:none";
  root.appendChild(s);
  const dur = 900;
  const t0 = performance.now();
  const dir = Math.random() < 0.5 ? 1 : -1; // which horizon it falls toward
  const r = 39 + Math.random() * 27; // orbit radius inside the dial art
  const step = (t: number) => {
    const k = (t - t0) / dur;
    if (k >= 1 || !root) {
      s.remove();
      return;
    }
    const a = Math.PI * (dir > 0 ? k : 1 - k); // 0..PI sweeps the semicircle
    s.style.left = `${DIAL.knobX - Math.cos(a) * r}px`;
    s.style.top = `${DIAL.knobY + Math.sin(a) * r * 0.8}px`;
    s.style.opacity = String(Math.sin(Math.PI * k));
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Show the dial for a TIME_PHASES index (0 Night, 1 Morning, 2 Day,
 * 3 Evening), cross-fading unless `instant` (join snaps straight in).
 * The HAND is driven separately by setClockProgress. */
export function setClockPhase(idx: number, instant = false) {
  mount();
  if (instant) {
    root!.classList.add("snap");
    root!.offsetWidth; // flush styles so the snap really skips the fade
  }
  dials.forEach((img, i) => img.classList.toggle("on", i === idx % dials.length));
  if (instant) {
    root!.offsetWidth;
    root!.classList.remove("snap");
  }
}

/** Sweep the hand to the continuous day position u = timeIdx + phaseT:
 * two half-day sweeps of -90..+90 across the 12-hour face (see the note at
 * HAND). The hand-off jump and continuous ticks SNAP; forward skips
 * (freeze-mode phase testing) ride the CSS transition. */
export function setClockProgress(u: number, instant = false) {
  mount();
  const um = (((u - 1.5) % 4) + 4) % 4; // 0 at morning-mid (a sweep start)
  const half = um < 2 ? um : um - 2; // 0..2 progress within the current sweep
  const target = -90 + (half / 2) * 180 - HAND.baseDeg;
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

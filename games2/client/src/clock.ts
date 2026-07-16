/**
 * Celestial clock — the time-of-day indicator hung top-centre of the game
 * view. Four pre-keyed dials (client/public/ui/clock_<phase>.png, built by
 * scripts/build-clock.mjs from the maintainer's mocks, pixel-aligned to each
 * other) are stacked and cross-faded on the same 2.5s clock as the ambient
 * grade. Order matches WorldScene's TIME_PHASES / shared timeIdx.
 *
 * Kept SUBTLE (maintainer, playtest round 2): a small dial tucked under the
 * top frame rail; the ARROW is the primary reading. The pointer hand
 * (ui/clock_hand.png) is its own layer above the dials — it never fades, it
 * only ROTATES to the phase's sector while the dials cross-fade under it.
 *
 * Angle convention (careful — this bit was shipped wrong once): CSS
 * rotate() is clockwise on screen, so rotating a DOWN-pointing hand by a
 * POSITIVE angle sweeps its tip toward screen-LEFT. All angles below are
 * "degrees from straight down, positive = left".
 */
import { applyUiZoom } from "./uiscale";

const PHASE_FILES = ["night", "morning", "day", "evening"] as const;
const FADE_S = 2.5; // keep in step with WorldScene's TIME_TRANSITION_S

// The dial is a four-sector gauge; the hand points the way the SUN'S
// SHADOWS fall (maintainer playtest round 3: "when the shadow is cast to
// the left the arrow points to the left"): morning shadows fall screen-
// right -> hand right, evening left -> hand left. So chronologically the
// hand sweeps RIGHT -> LEFT, and it uses the FULL semicircle (round 4):
// morning pops up 100% right (horizontal), night parks 100% left, with
// day/evening 30 deg either side of straight down. Then the CW-only rule
// swings it over the top for the new morning.
// Index order = TIME_PHASES / shared timeIdx (0 Night, 1 Morning, ...).
const HAND_DEG = [90, -90, -30, 30];

// The assets are baked AT display resolution (see build-clock.mjs — the
// browser must never resample them; that made the border mush next to the
// crisp HUD frame) and rendered 1 asset px = 1 CSS px, pixelated.
const DIAL = { w: 179, h: 104, knobX: 89.5, knobY: 5.5 }; // asset px
const ROOT_W = DIAL.w;
// Measured by scripts/build-clock.mjs from the keyed, flipped, downscaled
// hand art: image size, pivot-hub centre, and its resting angle
// (down-left = +42.2 in the convention above).
const HAND = { w: 63, h: 69, hubX: 54.4, hubY: 8.0, baseDeg: 42.2 };
const F = 1;
const HAND_SCALE = 1;

let root: HTMLDivElement | null = null;
// The hand lives in its OWN fixed layer ABOVE the page-frame art (z 7 vs
// the frame's 6, dials at 5): at the 100%-horizontal night/morning stops
// it lies along the frame rail and would vanish behind it otherwise — on
// top it reads as resting on the rail, and the over-the-top CW sweep
// stays visible.
let handRoot: HTMLDivElement | null = null;
let dials: HTMLImageElement[] = [];
let hand: HTMLImageElement | null = null;
// Cumulative CSS rotation. The hand only ever advances CLOCKWISE
// (maintainer: night -> morning must continue over the top, never sweep
// backwards through the day), so this grows monotonically — 360° per full
// game day — and the transition always takes the CW path.
let handDeg: number | null = null;

function mount() {
  if (root) return;
  const style = document.createElement("style");
  style.textContent = `
  .ml-clock,.ml-clock-hand{position:fixed;top:36px;left:50%;
    transform:translateX(-50%);width:${ROOT_W}px;pointer-events:none}
  .ml-clock{z-index:5}
  .ml-clock-hand{z-index:7}
  .ml-clock img,.ml-clock-hand img{position:absolute;top:0;left:0;width:100%;
    opacity:0;image-rendering:pixelated;transition:opacity ${FADE_S}s ease}
  .ml-clock img.on{opacity:1}
  .ml-clock-hand img{opacity:1;transition:transform ${FADE_S}s ease}
  .ml-clock.snap img,.ml-clock-hand.snap img{transition:none}`;
  document.head.appendChild(style);
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
  const s = HAND_SCALE;
  const knob = { x: DIAL.knobX * F, y: DIAL.knobY * F };
  hand.style.width = `${HAND.w * s}px`;
  hand.style.left = `${knob.x - HAND.hubX * s}px`;
  hand.style.top = `${knob.y - HAND.hubY * s}px`;
  hand.style.transformOrigin = `${HAND.hubX * s}px ${HAND.hubY * s}px`;
  handRoot.appendChild(hand);
  document.body.appendChild(root);
  document.body.appendChild(handRoot);
  applyUiZoom(root);
  applyUiZoom(handRoot);
}

/** Show the dial for a TIME_PHASES index (0 Night, 1 Morning, 2 Day,
 * 3 Evening), cross-fading unless `instant` (join snaps straight in). */
export function setClockPhase(idx: number, instant = false) {
  mount();
  if (instant) {
    root!.classList.add("snap");
    handRoot!.classList.add("snap");
    root!.offsetWidth; // flush styles so the snap really skips the fade
  }
  dials.forEach((img, i) => img.classList.toggle("on", i === idx % dials.length));
  const target = HAND_DEG[idx % HAND_DEG.length] - HAND.baseDeg;
  if (handDeg === null || instant) handDeg = target;
  else handDeg += ((((target - handDeg) % 360) + 360) % 360); // CW only
  hand!.style.transform = `rotate(${handDeg}deg)`;
  if (instant) {
    root!.offsetWidth;
    root!.classList.remove("snap");
    handRoot!.classList.remove("snap");
  }
}

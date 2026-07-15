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

// The dial is a four-sector gauge read left -> right chronologically:
// Morning, Day, Evening, Night at the sector centres. Matches the in-game
// sun (morning sun west/left, evening east/right); night parks rightmost,
// then the hand sweeps back across the dial for the new morning.
// Index order = TIME_PHASES / shared timeIdx (0 Night, 1 Morning, ...).
const HAND_DEG = [-67.5, 67.5, 22.5, -22.5];

// Display size: dial width in CSS px — everything else derives from it.
const ROOT_W = 176;
const DIAL = { w: 716, h: 419, knobX: 358, knobY: 22 }; // mock px (keyed crop)
// Measured by scripts/build-clock.mjs from the keyed, flipped hand art:
// image size, pivot-hub centre, and its resting angle (down-left = +42.2
// in the convention above).
const HAND = { w: 504, h: 552, hubX: 437.6, hubY: 67.0, baseDeg: 42.2 };
// Hand px -> CSS px: sized so the tip reaches ~85% of the dial radius —
// the arrow must stay legible at the small dial size (it IS the reading).
// Hand length 652 mock px (hub centre -> tip), dial radius 358 mock px.
const F = ROOT_W / DIAL.w;
const HAND_SCALE = (358 * F * 0.85) / 652;

let root: HTMLDivElement | null = null;
let dials: HTMLImageElement[] = [];
let hand: HTMLImageElement | null = null;

function mount() {
  if (root) return;
  const style = document.createElement("style");
  style.textContent = `
  .ml-clock{position:fixed;top:36px;left:50%;transform:translateX(-50%);z-index:5;
    width:${ROOT_W}px;pointer-events:none}
  .ml-clock img{position:absolute;top:0;left:0;width:100%;opacity:0;
    transition:opacity ${FADE_S}s ease}
  .ml-clock img.on{opacity:1}
  .ml-clock img.ml-hand{opacity:1;transition:transform ${FADE_S}s ease}
  .ml-clock.snap img{transition:none}`;
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
  // about that point (last in DOM = drawn above every dial).
  hand = document.createElement("img");
  hand.src = "/ui/clock_hand.png";
  hand.className = "ml-hand";
  hand.alt = "";
  hand.draggable = false;
  const s = HAND_SCALE;
  const knob = { x: DIAL.knobX * F, y: DIAL.knobY * F };
  hand.style.width = `${HAND.w * s}px`;
  hand.style.left = `${knob.x - HAND.hubX * s}px`;
  hand.style.top = `${knob.y - HAND.hubY * s}px`;
  hand.style.transformOrigin = `${HAND.hubX * s}px ${HAND.hubY * s}px`;
  root.appendChild(hand);
  document.body.appendChild(root);
  applyUiZoom(root);
}

/** Show the dial for a TIME_PHASES index (0 Night, 1 Morning, 2 Day,
 * 3 Evening), cross-fading unless `instant` (join snaps straight in). */
export function setClockPhase(idx: number, instant = false) {
  mount();
  if (instant) {
    root!.classList.add("snap");
    root!.offsetWidth; // flush styles so the snap really skips the fade
  }
  dials.forEach((img, i) => img.classList.toggle("on", i === idx % dials.length));
  hand!.style.transform = `rotate(${HAND_DEG[idx % HAND_DEG.length] - HAND.baseDeg}deg)`;
  if (instant) {
    root!.offsetWidth;
    root!.classList.remove("snap");
  }
}

/**
 * Celestial clock — the time-of-day indicator hung top-centre of the game
 * view. Four pre-keyed dials (client/public/ui/clock_<phase>.png, built by
 * scripts/build-clock.mjs from the maintainer's mocks, pixel-aligned to each
 * other) are stacked and cross-faded on the same 2.5s clock as the ambient
 * grade. Order matches WorldScene's TIME_PHASES / shared timeIdx.
 *
 * Kept SUBTLE (maintainer, playtest round 2), and at the HUD frame's pixel
 * GRAIN (round 6: "same per pixel size resolution as the frame — zoom in A
 * LOT"): assets are baked on a coarse art grid and every art px renders as
 * a fat ${PX} CSS px block, integer-scaled + pixelated.
 *
 * The ARROW is the primary reading and lives above the frame art. At REST
 * it is a pre-rotated, dial-grid-aligned chunky sprite (clock_hand_<phase>);
 * a runtime-rotated chunky hand dissolves into dotted diamonds. Only during
 * the 2.5s sweep does a finer hand (clock_hand.png) rotate — motion masks
 * its finer grain, then it settles into the crisp sprite (same idea as the
 * camera settling to integer zoom).
 *
 * Angle convention (careful — this shipped wrong once): CSS rotate() is
 * clockwise on screen, so rotating a DOWN-pointing hand by a POSITIVE angle
 * sweeps its tip toward screen-LEFT. All angles below are "degrees from
 * straight down, positive = left".
 */
import { applyUiZoom } from "./uiscale";

const PHASE_FILES = ["night", "morning", "day", "evening"] as const;
const FADE_S = 2.5; // keep in step with WorldScene's TIME_TRANSITION_S

// The hand points EXACTLY the way the sun's shadows fall ON SCREEN
// (maintainer round 3+5: hand direction = shadow direction, no artistic
// re-spacing). Angles derive from WorldScene's SUN_PHASES cast vectors
// through the iso projection (screen px = ((col-row)*32, (col+row)*13)):
// Morning shadows point screen-right (-90), Day down-left (+50.7 — the
// midday sun keeps a west tilt and the iso squash steepens it), Evening
// horizontal-left (+90). Night has no sun: the hand STAYS where the sun
// set (100% left), then sweeps CW over the top for the new morning
// (round 4). Recompute if SUN_PHASES ever changes, and KEEP IN SYNC with
// HAND_DEG in scripts/build-clock.mjs (it bakes the rest sprites).
// Index order = TIME_PHASES / shared timeIdx (0 Night, 1 Morning, ...).
const HAND_DEG = [90, -90, 50.7, 90];

const PX = 4; // CSS px per asset art px — matches the frame's grain
const DIAL = { w: 44, h: 26, knobX: 22.4, knobY: 1.4 }; // asset px
const ROOT_W = DIAL.w * PX;
// The fine (sweep-only) hand, measured by build-clock.mjs: size, pivot-hub
// centre, resting angle (down-left = +42.2 in the convention above). It
// displays at 1 asset px = 1 CSS px so its length matches the rest sprites.
const FINE = { w: 63, h: 69, hubX: 54.4, hubY: 8.0, baseDeg: 42.2 };
// Rest sprites are dial-grid overlays with 1 art row of headroom above the
// dial's flat top (HAND_PAD in the build script).
const REST_TOP = -1 * PX;

let root: HTMLDivElement | null = null;
// The hand lives in its OWN fixed layer ABOVE the page-frame art (z 7 vs
// the frame's 6, dials at 5): at the 100%-horizontal night/morning stops
// it lies along the frame rail and would vanish behind it otherwise — on
// top it reads as resting on the rail, and the over-the-top CW sweep
// stays visible.
let handRoot: HTMLDivElement | null = null;
let dials: HTMLImageElement[] = [];
let fineHand: HTMLImageElement | null = null;
let restHand: HTMLImageElement | null = null;
let restTimer: ReturnType<typeof setTimeout> | null = null;
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
  .ml-clock-hand img{opacity:1;transition:none}
  .ml-clock-hand img.ml-fine{transition:transform ${FADE_S}s ease}
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
  handRoot = document.createElement("div");
  handRoot.className = "ml-clock-hand";
  // Resting hand: a dial-aligned chunky sprite, swapped per phase.
  restHand = document.createElement("img");
  restHand.alt = "";
  restHand.draggable = false;
  restHand.style.top = `${REST_TOP}px`;
  handRoot.appendChild(restHand);
  // Sweeping hand: hub centred on the dial's knob, rotates about it.
  fineHand = document.createElement("img");
  fineHand.src = "/ui/clock_hand.png";
  fineHand.className = "ml-fine";
  fineHand.alt = "";
  fineHand.draggable = false;
  const knob = { x: DIAL.knobX * PX, y: DIAL.knobY * PX };
  fineHand.style.width = `${FINE.w}px`;
  fineHand.style.left = `${knob.x - FINE.hubX}px`;
  fineHand.style.top = `${knob.y - FINE.hubY}px`;
  fineHand.style.transformOrigin = `${FINE.hubX}px ${FINE.hubY}px`;
  fineHand.style.display = "none";
  handRoot.appendChild(fineHand);
  document.body.appendChild(root);
  document.body.appendChild(handRoot);
  applyUiZoom(root);
  applyUiZoom(handRoot);
}

function showRest(idx: number) {
  restHand!.src = `/ui/clock_hand_${PHASE_FILES[idx % PHASE_FILES.length]}.png`;
  restHand!.style.display = "";
  fineHand!.style.display = "none";
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

  const target = HAND_DEG[idx % HAND_DEG.length] - FINE.baseDeg;
  if (restTimer) {
    clearTimeout(restTimer);
    restTimer = null;
  }
  if (handDeg === null || instant) {
    handDeg = target;
    fineHand!.style.transform = `rotate(${handDeg}deg)`;
    showRest(idx);
  } else {
    const delta = (((target - handDeg) % 360) + 360) % 360; // CW only
    if (delta === 0) {
      showRest(idx); // same angle (evening -> night): no sweep needed
    } else {
      // Sweep with the fine hand from the current angle, then settle into
      // the chunky rest sprite.
      if (fineHand!.style.display === "none") {
        handRoot!.classList.add("snap");
        fineHand!.style.transform = `rotate(${handDeg}deg)`;
        fineHand!.style.display = "";
        restHand!.style.display = "none";
        fineHand!.offsetWidth; // commit the start angle without transition
        handRoot!.classList.remove("snap");
      }
      handDeg += delta;
      fineHand!.style.transform = `rotate(${handDeg}deg)`;
      restTimer = setTimeout(() => showRest(idx), FADE_S * 1000 + 100);
    }
  }
  if (instant) {
    root!.offsetWidth;
    root!.classList.remove("snap");
  }
}

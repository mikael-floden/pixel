// THE SPIN BAR — his rotating orb between two arrow buttons, on the line
// directly under the HP/EP card (maintainer 2026-09-26: "I want the animation
// to be in center and a arrow left button on the left side and arrow right
// button on the right side… The left button should align with the card left.
// The right button should align with the card right. The animation in the
// middle").
//
// THE BUTTONS ARE THE 🔍 SQUARE, to the pixel ("The arrow button should look
// like the wiki search button in size"): PILL_H content-box, 1px
// --border-strong, radius 7, --shadow, 76% --bg over a 5px blur, scale(.96)
// on press. Those declarations are WRITTEN OUT here rather than shared with
// wikinear.ts for the reason recbtn.ts gives — the modules are about different
// things and one pill class would couple them — so `verify-spinbar` compares
// this button's COMPUTED style against the LIVE .ml-wikinear instead. Restyle
// the search square and this fails until it follows.
//
// ONE ICON, MIRRORED IN CSS ("use the arrow icon I uploaded (one has to be
// flipped)"): his 24x24 Right_Arrow export bakes to /ui2/icon-arrow.webp at an
// exact 2x like every other corner icon, and the LEFT button wears the same
// file under `transform:scaleX(-1)`. A second baked file would be a second
// thing to keep in sync with his art for no more meaning — and unlike the
// search glass, whose mirror is baked because the mirrored reading IS the
// icon, here both readings ship and neither is canonical.
//
// THE ORB IS NOT A BUTTON ("The gif should be in the middle (not a button)").
// It is pointer-events:none and carries no role; the two squares are the only
// things that take a press.
//
// A STRIP, NOT A GIF. A GIF cannot be scrubbed — the browser owns its clock,
// and this animation has to run forwards on one press and BACKWARDS on the
// other ("you have to play it backwards to get the other direction working").
// bake-corner-icons.py lays his frames out in one horizontal 2x strip and the
// CSS steps `background-position` through it, which is frame-exact in both
// directions and one request.
//
// THE STRIP IS ONE QUARTER TURN, and the art declares its own frame count:
// FRAMES = naturalWidth / naturalHeight (512/64 = 8), so re-baking with a
// different trim needs no change here. One press plays the whole strip and
// lands back on frame 0, which is the next quarter's 0° — that is what "remove
// some frames from the gif so it ends on a perfect 90° rotation" asks for, and
// it is why a press is 8 steps rather than 2. The trim itself, and the
// measurements behind it, are in bake-corner-icons.py's STRIPS block.
//
// WHAT IT DRIVES: nothing yet, deliberately. Each press emits `ml-spin` with
// the new quarter and the direction, so whatever this ends up turning can
// subscribe without this module having to know about it.
import { withV } from "./assetver";

const BAR = "ml-spinbar";
const BTN = "ml-spinbtn";
const ORB = "ml-spinorb";
const CSS_ID = "ml-spinbar-css";
/** The project's one edge margin — and the gap under the card. */
const GAP = 10;
/** The 🔍 square's box (wikinear.ts, which takes it from wikibtn.ts PILL_H). */
const BTN_H = 32;
/** Its outer height: the content box plus its own 1px borders. */
const BTN_OUTER = BTN_H + 2;
/** One press steps the whole strip; at 8 frames a quarter turn takes 360 ms.
 *  NOT the GIF's authored 200 ms — that is a 1.6 s answer to a button press,
 *  and a control has to feel like it moved when the finger lifts. */
const STEP_MS = 45;

let bar: HTMLElement | null = null;
let orb: HTMLElement | null = null;
/** Frames in the strip, read from the bake (naturalWidth / naturalHeight). */
let frames = 0;
/** Which quarter the orb is showing: 0..3, and what `ml-spin` reports. */
let quarter = 0;
/** The running animation, so a second press cannot interleave with it. */
let raf = 0;

/** How far the Report button (recbtn.ts) has to drop to clear this row:
 *  "(over recording if recording is visble)" — this bar takes the line under
 *  the card and the Report button moves down one step. Published rather than
 *  hardcoded there so the two cannot disagree. */
const STEP = `${BTN_OUTER + GAP}px`;

function frameAt(i: number): void {
  if (!orb || !frames) return;
  orb.style.backgroundPositionX = `${-i * BTN_H}px`;
}

/** Play the strip end to end — forward for right, backward for left — landing
 *  on frame 0 either way, which is the quarter boundary. */
function spin(dir: 1 | -1): void {
  if (raf || !frames) return;
  const t0 = performance.now();
  const total = frames; // 8 steps: 1..7 then 0 (or 7..1 then 0)
  const tick = (now: number) => {
    const step = Math.min(total, Math.floor((now - t0) / STEP_MS) + 1);
    frameAt(((step * dir) % frames + frames) % frames);
    if (step < total) {
      raf = requestAnimationFrame(tick);
      return;
    }
    raf = 0;
    quarter = (quarter + dir + 4) % 4;
    window.dispatchEvent(new CustomEvent("ml-spin", { detail: { quarter, dir } }));
  };
  raf = requestAnimationFrame(tick);
}

function makeButton(dir: 1 | -1): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `${BTN} ${dir < 0 ? "left" : "right"}`;
  b.type = "button";
  b.title = dir < 0 ? "Turn left" : "Turn right";
  b.setAttribute("aria-label", dir < 0 ? "Turn left" : "Turn right");
  const icon = document.createElement("img");
  icon.className = `${BTN}-icon`;
  icon.src = withV("/ui2/icon-arrow.webp");
  icon.alt = ""; // decorative: the button carries title + aria-label
  icon.draggable = false;
  // TRUE PIXEL SCALE, the rule every /ui2 icon follows: a bake is an exact 2x
  // of its authored art, so natural/2 lands on that grid at any density.
  const fit = () => {
    if (!icon.naturalWidth) return;
    icon.style.width = `${icon.naturalWidth / 2}px`;
    icon.style.height = `${icon.naturalHeight / 2}px`;
  };
  icon.addEventListener("load", fit);
  fit();
  b.appendChild(icon);
  b.addEventListener("click", () => spin(dir));
  b.addEventListener("touchstart", () => b.classList.add("press"), { passive: true });
  const up = () => b.classList.remove("press");
  b.addEventListener("touchend", up);
  b.addEventListener("touchcancel", up);
  return b;
}

export function mountSpinBar(): void {
  document.querySelectorAll(`.${BAR}`).forEach((e) => e.remove());
  injectStyles();
  document.documentElement.style.setProperty("--ml-spin-step", STEP);
  bar = document.createElement("div");
  bar.className = BAR;
  orb = document.createElement("div");
  orb.className = ORB;
  const src = withV("/ui2/spin-orb.webp");
  orb.style.backgroundImage = `url("${src}")`;
  // THE ART DECLARES ITS OWN FRAME COUNT: the strip is square frames in a row,
  // so naturalWidth / naturalHeight IS the count and a re-bake with a different
  // trim needs nothing here. Sized natural/2 like every other /ui2 bake.
  // The SIZE needs no probe and must not wait for one: `background-size:auto
  // <BTN_H>px` is natural/2 for any exact-2x bake, so the first paint is
  // already on the authored grid (the CSS carries it). Only the COUNT needs
  // the pixels.
  const probe = new Image();
  probe.onload = () => {
    if (!probe.naturalHeight) return;
    frames = Math.round(probe.naturalWidth / probe.naturalHeight);
  };
  probe.src = src;
  bar.appendChild(makeButton(-1));
  bar.appendChild(orb);
  bar.appendChild(makeButton(1));
  document.body.appendChild(bar);
}

/** QA probe: the frame on screen and the quarter it belongs to — the strip is
 *  a background-position, which a gate cannot otherwise read back. */
(window as unknown as { __mlSpin?: () => unknown }).__mlSpin = () => ({
  frames,
  quarter,
  spinning: raf !== 0,
  frame: orb ? Math.round(-parseFloat(getComputedStyle(orb).backgroundPositionX || "0") / BTN_H) : -1,
});

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.id = CSS_ID;
  s.textContent = `
  /* THE CARD'S OWN SPAN, both edges: the card starts at the project's 10px
     from the game view's left and --bars-l-w is its MEASURED outer width
     (hud.ts applyLayout), so a row of exactly that width puts the left button
     on the card's left edge and the right button on its right. Measuring the
     card is what lets this follow any width bars.ts chooses without a change
     here — the same reason recbtn.ts does it. The line is the one the Report
     button used to hold: the card's underside plus the one gap. */
  .${BAR}{position:fixed;left:calc(var(--gv-left,0px) + ${GAP}px);
    top:calc(${GAP}px + var(--ml-safe-top, 0px) + var(--bars-l-h, 78px) + ${GAP}px);
    z-index:8;width:var(--bars-l-w, ${BTN_OUTER * 2 + BTN_H}px);height:${BTN_OUTER}px;
    display:flex;align-items:center;justify-content:space-between;
    pointer-events:none;transition:left .3s ease,top .3s ease}
  /* Frozen through a rotation like the rest of the chrome (hud.ts .ml-noanim):
     a real rotation restages the viewport several times and a transition
     started on a half-staged layout crawls to its new place on screen. */
  :root.ml-noanim .${BAR}{transition:none}
  /* The 🔍 square's rules (wikinear.ts), which are the Wiki pill's (wikibtn.ts)
     at the pill's height on both sides. verify-spinbar compares the computed
     values against the live .ml-wikinear rather than trusting this copy. */
  .${BTN}{pointer-events:auto;width:${BTN_H}px;height:${BTN_H}px;box-sizing:content-box;padding:0;
    border:1px solid var(--border-strong);border-radius:7px;
    box-shadow:var(--shadow);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    color:var(--ink);-webkit-tap-highlight-color:transparent;user-select:none}
  .${BTN}-icon{image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  /* ONE BAKE, TWO READINGS: his export points right, so the left button is the
     same file mirrored. A pure scaleX on a pixelated image moves whole pixels
     and resamples nothing. */
  .${BTN}.left .${BTN}-icon{transform:scaleX(-1)}
  .${BTN}.press,.${BTN}:active{transform:scale(.96)}
  /* NOT A BUTTON: no pointer events, no border, no plate — his animation alone,
     at the /ui2 natural/2 scale, stepped by background-position. */
  .${ORB}{width:${BTN_H}px;height:${BTN_H}px;pointer-events:none;
    background-repeat:no-repeat;background-position:0 0;
    background-size:auto ${BTN_H}px;image-rendering:pixelated}
`;
  document.head.appendChild(s);
}

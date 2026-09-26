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
// THE STRIP IS ONE QUARTER TURN AND CARRIES EVERY FRAME OF IT. The art
// declares its own count — FRAMES = naturalWidth / naturalHeight — and a press
// plays exactly that many steps, so every authored transition runs once and the
// last one lands back on frame 0. NEVER TRIM A CLOSED LOOP FOR SMOOTHNESS: his
// export hands its last frame back to its first, so N frames are N transitions,
// and dropping one replaces two of them with a join covering twice the
// rotation. An 8-of-9 cut shipped on 2026-09-26 and he saw the seam the same
// day ("the rotation animation snaps at the last frame") — at the cut, which is
// the only place it can be. That report also fixed the clip's span: a press
// plays the whole strip, and a full 360° would have read as a full spin rather
// than a seam.
// WHAT IT DRIVES: the world's view turn (WorldScene listens to these buttons'
// taps and to `ml-spin`, which carries the quarter it settled on and fires ONCE
// per rest, because four quick taps are one 360° journey and not four events).
// While the world turns, the cube FOLLOWS it (`ml-view-angle`, below).
import { withV } from "./assetver";

const BAR = "ml-spinbar";
const BTN = "ml-spinbtn";
const ORB_CLS = "ml-spinorb";
const CSS_ID = "ml-spinbar-css";
/** The project's one edge margin — and the gap under the card. */
const GAP = 10;
/** The 🔍 square's box (wikinear.ts, which takes it from wikibtn.ts PILL_H). */
const BTN_H = 32;
/** Its outer height: the content box plus its own 1px borders. */
const BTN_OUTER = BTN_H + 2;
/** THE MIDDLE ART'S BOX — his cube at TRUE PIXEL SIZE (maintainer 2026-09-26: "I
 *  did the new cube bigger because the old cube wasn't big enough"; he chose one
 *  art pixel per point over the orb's 32 pt slot). The bake crops his 64x64 export
 *  to the 44x44 that holds every frame's ink and doubles it exactly, so natural/2
 *  is 44: the art's grid, and the frame step. Taller than the buttons, so the ROW
 *  is this tall and the buttons centre on it. */
const ORB = 44;
/** The row's height: whichever of the two is taller. */
const ROW_H = Math.max(BTN_OUTER, ORB);
/** THE TARGET IS BIGGER THAN THE BUTTON (maintainer 2026-09-26: "The rotation
 *  buttons will also be something the player will click a lot and I dont want
 *  the player to missclick here so you need to make the button hitbox 25%
 *  bigger in width and height"). The PAINTED box stays the 🔍 square — he
 *  fixed that look in the same breath as asking for this — so the growth is an
 *  invisible ::before, not a bigger button: 34 -> 42.5 on both axes, which is
 *  half of 25% on each side. It grows INTO the 10px margins and nothing else:
 *  4.25 < 10 leaves the Report button under it and the card above it untouched,
 *  which verify-spinbar asserts rather than trusting this arithmetic. */
const HIT_GROW = 0.25;
const HIT_PAD = (BTN_OUTER * HIT_GROW) / 2;
/** One press steps the whole strip; at 8 frames a quarter turn takes 360 ms.
 *  NOT the GIF's authored 200 ms — that is a 1.6 s answer to a button press,
 *  and a control has to feel like it moved when the finger lifts. */
const STEP_MS = 45;

let bar: HTMLElement | null = null;
let orb: HTMLElement | null = null;
/** Frames in the strip, read from the bake (naturalWidth / naturalHeight).
 *  ONE QUARTER TURN, so it is also the frames-per-quarter. */
let frames = 0;
/** WHERE THE ORB IS, and WHERE IT IS HEADING, both in frames and both
 *  UNWRAPPED — that is the whole design (maintainer 2026-09-26).
 *
 *  A tap does not queue an animation; it moves `targetF` by one quarter, and
 *  one loop travels the SIGNED distance to it. Every rule he gave falls out of
 *  that and none of them needed a case of its own:
 *   - "left arrow and then the right arrow during the animation… should change
 *     direction immidiatly and go back to the original position" — the two taps
 *     cancel on the target, the remaining distance flips sign, and the very
 *     next frame walks back. Nothing is queued, so there is nothing to drain.
 *   - "twice on left or twice on right… 180°. 3 taps = 270°. 4 taps = 360°" —
 *     taps ACCUMULATE, so four of them are four quarters of travel, not a
 *     target normalised to where it started.
 *   - "always the shortest rotation towards the goal and not spin around if
 *     going backwards is a shorter rotational distance" — an unwrapped target
 *     makes the long way round inexpressible: `targetF - curF` IS the route.
 *  Both are reduced by a whole turn once it settles, so a long session cannot
 *  drift them into large numbers; reducing both by the same multiple changes
 *  neither the frame shown nor the quarter. */
let curF = 0;
let targetF = 0;
/** The running loop and the timestamp it last integrated. */
let raf = 0;
let last = 0;

/** How far the Report button (recbtn.ts) has to drop to clear this row:
 *  "(over recording if recording is visble)" — this bar takes the line under
 *  the card and the Report button moves down one step. Published rather than
 *  hardcoded there so the two cannot disagree. */
const STEP = `${ROW_H + GAP}px`;

function frameAt(i: number): void {
  if (!orb || !frames) return;
  orb.style.backgroundPositionX = `${-i * ORB}px`;
}

/** The strip frame for a position: rounded, then wrapped into the strip. */
function draw(): void {
  if (!frames) return;
  frameAt(((Math.round(curF) % frames) + frames) % frames);
}

/** The quarter an unwrapped position belongs to, 0..3 — what `ml-spin` says. */
const quarterOf = (f: number) => (frames ? ((Math.round(f / frames) % 4) + 4) % 4 : 0);

/** THE WORLD'S ANGLE, while the world turns (WorldScene publishes it every frame
 *  on `ml-view-angle`, in this bar's quarters, with the goal its taps set): the
 *  cube draws where the WORLD is instead of running a clock of its own — the two
 *  drifted apart, the cube done in 0.4 s while the world was still preparing its
 *  turn (maintainer 2026-09-26: "it's not in sync with the cube rotation"). The
 *  world counts the same taps, so `worldLag` — how far it still has to turn, in
 *  frames — is all the cube needs: it stands at `targetF - worldLag`. A world
 *  that stops publishing is let go after WORLD_STALE_MS, and the cube finishes
 *  on its own clock. */
let worldLag: number | null = null;
let worldBusy = false;
let worldAt = 0;
/** Longer than a quarter's frame-A captures and its swap, during which the world
 *  publishes nothing but is still turning. */
const WORLD_STALE_MS = 1500;
window.addEventListener("ml-view-angle", (e) => {
  const d = (e as CustomEvent<{ q?: number; goal?: number; busy?: boolean }>).detail;
  if (!d || typeof d.q !== "number" || typeof d.goal !== "number" || !frames) return;
  worldLag = (d.goal - d.q) * frames;
  worldBusy = !!d.busy;
  worldAt = performance.now();
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
});

const tick = (now: number) => {
  // A BACKGROUNDED TAB MUST NOT TELEPORT IT. rAF stops while hidden, so the
  // first frame back carries the whole gap; clamped, the orb simply resumes
  // from where it was, which is what a paused animation should look like.
  const dt = Math.min(200, Math.max(0, now - last));
  last = now;
  if (worldLag !== null) {
    if (now - worldAt > WORLD_STALE_MS) worldLag = null;
    else {
      // FOLLOWING THE WORLD: never past the target, never behind where it was
      // asked to come back from — the lag is the world's own
      curF = targetF - worldLag;
      if (worldBusy || Math.abs(worldLag) > 1e-6) {
        draw();
        raf = requestAnimationFrame(tick);
        return;
      }
      worldLag = null; // the world rests on the goal: land below, as ever
    }
  }
  const remain = targetF - curF;
  const step = dt / STEP_MS;
  if (Math.abs(remain) <= step) {
    // LANDED, always on a quarter boundary because every tap moves the target
    // by exactly one: the frame shown is 0, "a perfect 90° rotation".
    curF = targetF;
    draw();
    raf = 0;
    const turn = frames * 4;
    if (turn) {
      const wrapped = ((targetF % turn) + turn) % turn;
      curF = targetF = wrapped; // same frame, same quarter, small numbers
    }
    window.dispatchEvent(new CustomEvent("ml-spin", { detail: { quarter: quarterOf(targetF) } }));
    return;
  }
  curF += Math.sign(remain) * step;
  draw();
  raf = requestAnimationFrame(tick);
};

/** A tap: one quarter onto the target, in the direction pressed. It never
 *  refuses — a press DURING the animation is the point. */
function nudge(dir: 1 | -1): void {
  if (!frames) return;
  targetF += dir * frames;
  // the world hears this tap too, a frame later: until it says so, the lag
  // grows with the target so the cube does not jump a quarter ahead
  if (worldLag !== null) worldLag += dir * frames;
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
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
  b.addEventListener("click", () => nudge(dir));
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
  orb.className = ORB_CLS;
  const src = withV("/ui2/spin-orb.webp");
  orb.style.backgroundImage = `url("${src}")`;
  // THE ART DECLARES ITS OWN FRAME COUNT: the strip is square frames in a row,
  // so naturalWidth / naturalHeight IS the count and a re-bake with a different
  // trim needs nothing here. Sized natural/2 like every other /ui2 bake.
  // The SIZE needs no probe and must not wait for one: `background-size:auto
  // <ORB>px` is natural/2 of the bake (the crop fixes its height), so the first
  // paint is already on the authored grid (the CSS carries it). Only the COUNT
  // needs the pixels.
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
  quarter: quarterOf(targetF),
  spinning: raf !== 0,
  frame: orb ? Math.round(-parseFloat(getComputedStyle(orb).backgroundPositionX || "0") / ORB) : -1,
  // in QUARTERS, unwrapped: curQ is where it is, targetQ where the taps put it.
  // A gate reads these rather than racing the compositor for a frame.
  curQ: frames ? curF / frames : 0,
  targetQ: frames ? targetF / frames : 0,
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
    z-index:8;width:var(--bars-l-w, ${BTN_OUTER * 2 + ORB}px);height:${ROW_H}px;
    display:flex;align-items:center;justify-content:space-between;
    pointer-events:none;transition:left .3s ease,top .3s ease}
  /* Frozen through a rotation like the rest of the chrome (hud.ts .ml-noanim):
     a real rotation restages the viewport several times and a transition
     started on a half-staged layout crawls to its new place on screen. */
  :root.ml-noanim .${BAR}{transition:none}
  /* The 🔍 square's rules (wikinear.ts), which are the Wiki pill's (wikibtn.ts)
     at the pill's height on both sides. verify-spinbar compares the computed
     values against the live .ml-wikinear rather than trusting this copy. */
  .${BTN}{pointer-events:auto;position:relative;width:${BTN_H}px;height:${BTN_H}px;box-sizing:content-box;padding:0;
    border:1px solid var(--border-strong);border-radius:7px;
    box-shadow:var(--shadow);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    color:var(--ink);-webkit-tap-highlight-color:transparent;user-select:none}
  /* The invisible ${Math.round(HIT_GROW * 100)}% — a pseudo-element inherits the button's own
     pointer-events, so this takes the press without painting anything and
     without moving the box the eye lines up against the card. */
  .${BTN}::before{content:"";position:absolute;inset:-${HIT_PAD}px}
  .${BTN}-icon{image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  /* ONE BAKE, TWO READINGS: his export points right, so the left button is the
     same file mirrored. A pure scaleX on a pixelated image moves whole pixels
     and resamples nothing. */
  .${BTN}.left .${BTN}-icon{transform:scaleX(-1)}
  .${BTN}.press,.${BTN}:active{transform:scale(.96)}
  /* NOT A BUTTON: no pointer events, no border, no plate — his animation alone,
     at the /ui2 natural/2 scale, stepped by background-position. */
  .${ORB_CLS}{width:${ORB}px;height:${ORB}px;pointer-events:none;
    background-repeat:no-repeat;background-position:0 0;
    background-size:auto ${ORB}px;image-rendering:pixelated}
`;
  document.head.appendChild(s);
}

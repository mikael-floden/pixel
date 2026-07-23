/**
 * On-screen ANALOG STICK — the gamepad tab's controller (maintainer
 * 2026-07-22: play without tapping the world).
 *
 * Art: the maintainer's SECOND-GEN thumbstick (2026-07-23, authored at 2x
 * pixel density so it renders at true 1x), split pixel-exactly along his
 * red-line cut into /ui2/pad-stick2-base.png (shaft + socket, its
 * cap-occluded rim and shaft top AI-filled and baked) and
 * /ui2/pad-stick2-top.png (the movable mushroom cap) — both on the same
 * registered 128x128 canvas (client/ui-src/gamepad/, scripts
 * extract-stick2.py + bake-stick2-base.py), so stacking the two <img>s at
 * equal size reproduces the source art with zero alignment math. The cap
 * moves by CSS transform only.
 *
 * Feel (maintainer's spec, tuned 2026-07-22):
 *  - The stick SNAPS TO 8 DIRECTIONS — it simulates the keyboard (WASD),
 *    nothing else: each octant maps to the same key set a keyboard player
 *    would hold (NE = W+D …), synthesized as real window KeyboardEvents.
 *    WorldScene's Phaser keyboard consumes them exactly like physical keys
 *    (prediction, server validation, keyboard-cancels-tap all identical) —
 *    no games-agent file is touched. Phaser reads event.keyCode, which the
 *    KeyboardEvent init dict can't set — defineProperty fills it in.
 *  - The CAP ITSELF snaps to the 8 directions too: engaged, it sits at
 *    FULL deflection along the active octant (like an arcade gate), and
 *    octant changes glide there through a FAST transition — "the snap
 *    should not be instant, but have a fast animation". The finger keeps
 *    steering at ANY distance past the travel radius without losing input
 *    (setPointerCapture keeps the drag alive far outside the well).
 *  - The art is AUTHORED IN THE REST POSE (cap seated on its shaft): a
 *    centered stick draws both tiles untransformed; deflections slide the
 *    cap off and reveal the AI-completed rim and shaft top beneath.
 *  - Dead zone around the centre releases all keys (rest = no input).
 *
 * Pixel art renders nearest-neighbour at true 1x — the 2x-density art IS
 * the thumb-perfect size (maintainer). LOOK vs FEEL: the finger/cap
 * TRAVEL keeps the ORIGINAL 4/3/2 tier's css distances (dead zone, run
 * threshold, full gate) — the gameplay contract has survived both the
 * half-size round and this art swap unchanged; in art units the cap
 * deflects up to 56 px past the socket on the design-width tier.
 */

import { gameAudio } from "../../composer/index";

// The SECOND-GEN art (2026-07-23): authored at true 1x for the thumb —
// 128x128 canvas, cap tile + socket tile (shaft stays with the socket, his
// red-line cut; the AI-filled rim/shaft-top hides behind the cap at rest).
// Drawn IN THE REST POSE, so the cap needs no seating offset at all.
const CANVAS = 128; // the art canvas (both pngs)
const CX = 64; // the cap's rest centre, art px — the finger's neutral point
const CY = 39;
// full-gate travel in FEEL-TIER units: css travel = TRAVEL * feelK, where
// feelK is the ORIGINAL 4/3/2 stepping — the gameplay contract that has
// survived both art swaps unchanged
const TRAVEL = 14;
// the assembly's VISIBLE vertical span at rest (cap top … base bottom), used
// to centre the whole stick in the page (maintainer's red line: equal
// margin above and below)
const CAP_TOP_ART = 10;
const BASE_BOT_ART = 120;
const DEAD_FRAC = 0.35; // of the max: inside this, all keys are up
const RUN_FRAC = 0.75; // of the max: past this amplitude the gait is RUN (Shift), else walk
const SNAP_MS = 80; // the fast (not instant) glide between snap positions
// Octants counter-clockwise from screen-east with y DOWN → index = round(angle/45°)
// mod 8 over atan2(dy,dx): E, SE, S, SW, W, NW, N, NE — each holds the keys a
// keyboard player would.
const SECTOR_KEYS: string[][] = [
  ["D"],
  ["S", "D"],
  ["S"],
  ["S", "A"],
  ["A"],
  ["W", "A"],
  ["W"],
  ["W", "D"],
];
const KEYCODE: Record<string, number> = { W: 87, A: 65, S: 83, D: 68, SHIFT: 16 };

function synthKey(kind: "keydown" | "keyup", k: string) {
  const e = new KeyboardEvent(
    kind,
    k === "SHIFT"
      ? { key: "Shift", code: "ShiftLeft", bubbles: true }
      : { key: k.toLowerCase(), code: `Key${k}`, bubbles: true },
  );
  // Phaser's KeyboardPlugin routes by event.keyCode — not settable via the
  // init dict, so define it on the instance.
  Object.defineProperty(e, "keyCode", { get: () => KEYCODE[k] });
  Object.defineProperty(e, "which", { get: () => KEYCODE[k] });
  window.dispatchEvent(e);
}

/** Mount the stick into the gamepad page. Idempotent per page element. */
export function mountGamepadStick(page: HTMLElement) {
  injectStyles();
  const pad = mk("div", "ml-pad-stick");
  const base = mk("img", "ml-pad-img") as HTMLImageElement;
  base.src = "/ui2/pad-stick2-base.png";
  const top = mk("img", "ml-pad-img ml-pad-top") as HTMLImageElement;
  top.src = "/ui2/pad-stick2-top.png";
  for (const im of [base, top]) {
    im.alt = "";
    im.draggable = false;
  }
  pad.append(base, top);
  page.appendChild(pad);

  // ── layout: integer art scale + the maintainer's marked anchor spot ──
  // (his red circle: the well centre at ~70.5% across, ~42% down the page)
  let k = 2;
  let maxCss = TRAVEL * 4; // full-gate travel in css px (feel tier, not k)
  // the cap's VISUAL state: the ANGLE snaps to the active octant (-1 =
  // centred, resting on the socket) but the AMPLITUDE is analog — the cap
  // follows the finger's distance up to the css travel clamp ("only snap
  // the angle, not the amplitude"). Radius kept in ART units so a scale
  // change re-derives.
  let visSector = -1;
  let visRadius = 0;
  const setCap = (sector: number, radiusArt: number) => {
    visSector = sector;
    visRadius = sector < 0 ? 0 : radiusArt;
    const a = (sector * Math.PI) / 4;
    const dx = sector < 0 ? 0 : Math.cos(a) * visRadius * k;
    const dy = sector < 0 ? 0 : Math.sin(a) * visRadius * k;
    // authored at rest — no seating offset, deflection is the whole story
    top.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const layout = () => {
    // FEEL tier: the original scale stepping — anchors the css travel
    const feelK = window.innerWidth >= 780 ? 4 : window.innerWidth >= 585 ? 3 : 2;
    // LOOK: the 2x-density art renders at true 1x everywhere
    k = 1;
    maxCss = TRAVEL * feelK;
    const size = CANVAS * k;
    pad.style.width = pad.style.height = `${size}px`;
    pad.style.left = `${Math.round(page.clientWidth * 0.705 - CX * k)}px`;
    // vertically CENTRE the resting assembly: equal margin above the cap and
    // below the base (maintainer's red-line round, 2026-07-22). The page
    // element runs on under the bottom frame rail with asymmetric padding
    // (--ml-page-padtop/-padbot are the frame's inner window), so centre in
    // the VISIBLE content box, not the raw clientHeight.
    const cs = getComputedStyle(page);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBot = parseFloat(cs.paddingBottom) || 0;
    const visH = page.clientHeight - padTop - padBot;
    const centreArt = (CAP_TOP_ART + BASE_BOT_ART) / 2;
    pad.style.top = `${Math.round(padTop + visH * 0.5 - centreArt * k)}px`;
    setCap(visSector, visRadius); // re-derive the k-scaled transform
  };
  layout();
  window.addEventListener("resize", layout);
  new ResizeObserver(layout).observe(page);

  // ── input ──
  const held = new Set<string>();
  const setKeys = (sector: number, run: boolean) => {
    // plain WASD walks; SHIFT held = run (WorldScene: running = SHIFT down)
    const want = sector < 0 ? [] : run ? [...SECTOR_KEYS[sector], "SHIFT"] : SECTOR_KEYS[sector];
    for (const key of [...held]) {
      if (!want.includes(key)) {
        held.delete(key);
        synthKey("keyup", key);
      }
    }
    for (const key of want) {
      if (!held.has(key)) {
        held.add(key);
        synthKey("keydown", key);
      }
    }
  };
  let dragging = false;
  const apply = (ev: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    const dx = ev.clientX - (r.left + CX * k);
    const dy = ev.clientY - (r.top + CY * k);
    const len = Math.hypot(dx, dy);
    // the ANGLE keeps working at any finger distance — only the cap's drawn
    // deflection is clamped. All thresholds are CSS px (the feel tier), so
    // halving the art did not change what the finger does.
    const max = maxCss;
    const sector = len < max * DEAD_FRAC ? -1 : (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;
    // amplitude → gait: a light tilt WALKS, past RUN_FRAC it RUNS
    setKeys(sector, len >= max * RUN_FRAC);
    // angle snapped, amplitude analog (clamped to the travel radius); the
    // SNAP_MS transition smooths both the octant glide and the radius
    setCap(sector, Math.min(len, max) / k);
  };
  const release = () => {
    if (!dragging) return;
    dragging = false;
    setKeys(-1, false);
    setCap(-1, 0); // glide back onto the socket
    gameAudio.event("ui.release");
  };
  pad.addEventListener("pointerdown", (ev) => {
    dragging = true;
    pad.setPointerCapture(ev.pointerId); // the finger may leave the well — keep it
    gameAudio.event("ui.press");
    apply(ev);
  });
  pad.addEventListener("pointermove", (ev) => {
    if (dragging) apply(ev);
  });
  pad.addEventListener("pointerup", release);
  pad.addEventListener("pointercancel", release);
  // never leave keys stuck if the tab/page goes away mid-drag
  window.addEventListener("blur", release);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) release();
  });
}

function mk(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = `
  .ml-pad-stick{position:absolute;touch-action:none;cursor:pointer;
    -webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
  .ml-pad-img{position:absolute;inset:0;width:100%;height:100%;
    image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  /* the cap glides between its snap positions — fast, not instant */
  .ml-pad-top{transition:transform ${SNAP_MS}ms ease-out}`;
  document.head.appendChild(s);
}

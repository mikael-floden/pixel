/**
 * On-screen ANALOG STICK — the gamepad tab's controller (maintainer
 * 2026-07-22: play without tapping the world).
 *
 * Art: the maintainer's "Classic Stock" thumbstick, split pixel-exactly into
 * /ui2/pad-stick-base.png (the socket well, Gemini-filled + his red/green
 * pixel edits) and /ui2/pad-stick-top.png (the movable cap) — both on the
 * same registered 96x96 canvas (client/ui-src/gamepad/, scripts
 * extract-stick.py + bake-stick-base.py), so stacking the two <img>s at
 * equal size reproduces the source art with zero alignment math. The cap
 * moves by CSS transform only.
 *
 * Feel (maintainer's spec):
 *  - The stick SNAPS TO 8 DIRECTIONS — it simulates the keyboard (WASD),
 *    nothing else: each octant maps to the same key set a keyboard player
 *    would hold (NE = W+D …), synthesized as real window KeyboardEvents.
 *    WorldScene's Phaser keyboard consumes them exactly like physical keys
 *    (prediction, server validation, keyboard-cancels-tap all identical) —
 *    no games-agent file is touched. Phaser reads event.keyCode, which the
 *    KeyboardEvent init dict can't set — defineProperty fills it in.
 *  - The cap's VISUAL travel is clamped (MAX_ART px — a real stick doesn't
 *    stretch), but the FINGER keeps steering at ANY distance past the max
 *    without losing the input: setPointerCapture keeps the drag alive far
 *    outside the well, only the drawn offset clamps.
 *  - Dead zone around the centre releases all keys (rest = no input).
 *
 * Pixel art scales nearest-neighbour at INTEGER factors only: 4x at the 980
 * design width, 3x / 2x on narrower viewports (same stepping idiom as the
 * HUD tab icons — the HUD layer is never uiZoom'd).
 */

import { gameAudio } from "../../composer/index";

const CANVAS = 96; // the art canvas (both pngs)
const CX = 46.5; // the socket well centre, art px
const CY = 60.5;
const MAX_ART = 9; // cap travel radius, art px ("should not drag the top too long")
const DEAD_FRAC = 0.35; // of the max: inside this, all keys are up
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
const KEYCODE: Record<string, number> = { W: 87, A: 65, S: 83, D: 68 };

function synthKey(kind: "keydown" | "keyup", k: string) {
  const e = new KeyboardEvent(kind, { key: k.toLowerCase(), code: `Key${k}`, bubbles: true });
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
  base.src = "/ui2/pad-stick-base.png";
  const top = mk("img", "ml-pad-img ml-pad-top") as HTMLImageElement;
  top.src = "/ui2/pad-stick-top.png";
  for (const im of [base, top]) {
    im.alt = "";
    im.draggable = false;
  }
  pad.append(base, top);
  page.appendChild(pad);

  // ── layout: integer art scale + the maintainer's marked anchor spot ──
  // (his red circle: the well centre at ~70.5% across, ~42% down the page)
  let k = 4;
  const layout = () => {
    k = window.innerWidth >= 780 ? 4 : window.innerWidth >= 585 ? 3 : 2;
    const size = CANVAS * k;
    pad.style.width = pad.style.height = `${size}px`;
    pad.style.left = `${Math.round(page.clientWidth * 0.705 - CX * k)}px`;
    pad.style.top = `${Math.round(page.clientHeight * 0.42 - CY * k)}px`;
  };
  layout();
  window.addEventListener("resize", layout);
  new ResizeObserver(layout).observe(page);

  // ── input ──
  const held = new Set<string>();
  const setKeys = (sector: number) => {
    const want = sector < 0 ? [] : SECTOR_KEYS[sector];
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
    const max = MAX_ART * k;
    // visual: clamp the cap to the well; input: the ANGLE keeps working at
    // any finger distance (the whole point of the clamp split)
    const f = len > max ? max / len : 1;
    top.style.transform = `translate(${dx * f}px, ${dy * f}px)`;
    if (len < max * DEAD_FRAC) setKeys(-1);
    else setKeys((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8);
  };
  const release = () => {
    if (!dragging) return;
    dragging = false;
    setKeys(-1);
    top.style.transform = "";
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
    image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}`;
  document.head.appendChild(s);
}

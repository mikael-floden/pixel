/**
 * The in-game WIKI BUTTON (maintainer 2026-08-13): the wiki drawer used to be
 * reachable only from the select screen; in the world it gets a button that
 * LIVES WITH the time-of-day pill — same size, same right edge, stacked on
 * the pill's open side, and riding every move the pill makes.
 *
 * The placement rule, read off the maintainer's three red-circled shots: the
 * button is the pill's NEIGHBOUR on the side facing into the screen — the
 * pill hugs the bottom edge in portrait and left-handed landscape, so the
 * button sits ABOVE it; in right-handed landscape the pill parks UNDER the
 * XP chip (its corner belongs to the thumb stick) and the button sits BELOW.
 * That is why every rule here is the pill's own rule plus one PILL_STEP:
 * anchors, the right-handed landscape flip, and the keyboard lift all mirror
 * `.ml-clock` (clock.ts + hud.ts's `:root.ml-kb-up .ml-clock`), so wherever
 * the pill goes — including up over the phone keyboard — the button follows
 * at a constant 10px gap. If the pill's anchoring ever changes, change this
 * file in the same commit.
 *
 * Unlike the pill it is a real BUTTON (the pill is pass-through): it opens
 * the wiki drawer (wikipanel.ts), which now remembers where in the wiki you
 * were — see the spot store there.
 */

import { openWikiPanel } from "./wikipanel";
import { withV } from "./assetver";

// The pill's box: 40x16 art pixels at x2 (clock.ts AW/AH/SCALE), content-box
// with a 1px border. The gate asserts this against the REAL pill's rect, so
// a resized pill fails loudly instead of the two drifting apart.
const PILL_W = 80;
const PILL_H = 32;
/** Outer pill height (2px of border) + the project's one 10px edge gap. */
const PILL_STEP = PILL_H + 2 + 10;

let root: HTMLButtonElement | null = null;

export function mountWikiButton(): void {
  // A HUD rebuild mounts again — clear strays first (the gamepad's pattern).
  document.querySelectorAll(".ml-wikibtn").forEach((e) => e.remove());
  injectStyles();
  root = document.createElement("button");
  root.className = "ml-wikibtn";
  root.type = "button";
  root.title = "Game wiki — all monsters, characters, tiles, sounds & tuning";
  // HIS OWN ART, not a font vendor's glyph (maintainer 2026-09-03) — the
  // PixelLab open old book, an exact 2x bake rendered at its authored 24px
  // grid by the shared /ui2 rule (naturalWidth/2, see hud.ts).
  const icon = document.createElement("img");
  icon.className = "ml-wikibtn-icon";
  icon.src = withV("/ui2/icon-wiki.webp");
  icon.alt = "";
  icon.draggable = false;
  const fit = () => {
    if (!icon.naturalWidth) return;
    icon.style.width = `${icon.naturalWidth / 2}px`;
    icon.style.height = `${icon.naturalHeight / 2}px`;
  };
  icon.addEventListener("load", fit);
  fit();
  root.append(icon, document.createTextNode("Wiki"));
  root.addEventListener("click", () => openWikiPanel());
  // CSS :active is hover-only on mobile — the HUD buttons' same press look.
  root.addEventListener("touchstart", () => root?.classList.add("press"), { passive: true });
  const up = () => root?.classList.remove("press");
  root.addEventListener("touchend", up);
  root.addEventListener("touchcancel", up);
  document.body.appendChild(root);
}

let injected = false;
function injectStyles(): void {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = `
  /* One PILL_STEP up from the pill's own anchor (clock.ts .ml-clock), same
     right edge, same transitions — the two move as a stack. z 8 = the pill's
     layer; unlike it this one takes pointer events. */
  .ml-wikibtn{position:fixed;right:calc(var(--gv-right,0px) + 10px);
    bottom:calc(var(--hud-h, 38.2dvh) + 10px + ${PILL_STEP}px);z-index:8;
    width:${PILL_W}px;height:${PILL_H}px;box-sizing:content-box;padding:0;
    border:1px solid var(--border-strong);border-radius:7px;
    box-shadow:var(--shadow);cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:5px;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    font:600 12px var(--sans);letter-spacing:.03em;color:var(--ink);
    transition:bottom .15s ease-out,right .3s ease,top .3s ease;
    -webkit-tap-highlight-color:transparent;user-select:none}
  .ml-wikibtn-icon{image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  .ml-wikibtn.press,.ml-wikibtn:active{transform:scale(.96)}
  /* RIGHT-HANDED LANDSCAPE: the pill is top-anchored under the XP chip, so
     the button flips BELOW it — the pill's rule plus one step. */
  :root.ml-land:not(.ml-lh) .ml-wikibtn{
    top:calc(var(--bars-r-h, 78px) + 20px + ${PILL_STEP}px);bottom:auto}
  /* The keyboard lift: hud.ts raises the pill to inputlift+56 — ride one
     step above it so the stack stays intact over the keys. */
  :root.ml-kb-up .ml-wikibtn{bottom:calc(var(--ml-inputlift) + 56px + ${PILL_STEP}px)}`;
  document.head.appendChild(s);
}

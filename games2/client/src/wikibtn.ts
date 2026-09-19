/**
 * The in-game WIKI BUTTON (maintainer 2026-08-13): the wiki drawer used to be
 * reachable only from the select screen; in the world it gets a button that
 * LIVES WITH the time-of-day pill — same size, same right edge, stacked on
 * the pill's open side, and riding every move the pill makes.
 *
 * WHERE THE ROW LIVES — three placements, one PILL_STEP between the row and
 * the pill in each:
 * - PORTRAIT (maintainer 2026-09-17, arrows on a screenshot: "wiki + search
 *   to be top right and listed right under the XP/level card… the
 *   time-of-day pill to also be top right but under the wiki. This means the
 *   thumbstick can be lowered"): TOP-right, directly under the XP chip, the
 *   pill one step under this row. The bottom corner is the portrait ghost
 *   stick's (gamepad.ts). Top-anchored, so the keyboard lift below is
 *   over-constrained and ignored — the row is nowhere near the keys.
 * - RIGHT-HANDED LANDSCAPE (maintainer 2026-08-05 / 2026-09-03): top-right
 *   too, but the PILL takes the spot under the chip and this row hangs one
 *   step under it — his verdict on that screen, not re-litigated here.
 * - LEFT-HANDED LANDSCAPE: the bottom corner is free (the stick is bottom-
 *   left), so this row takes the corner anchor and the pill steps up over
 *   it (2026-09-03: "the wiki+search is under the time-of-day pill"), and
 *   the keyboard lift moves both by the same step.
 * Every rule here is the pill's own rule ± one PILL_STEP: anchors, flips and
 * the keyboard lift mirror `.ml-clock` (clock.ts + hud.ts's `:root.ml-kb-up
 * .ml-clock`). If the pill's anchoring ever changes, change this file in the
 * same commit.
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
/** The 🔍 square beside it (wikinear.ts) and the one gap between them — the
 *  row's other two terms, so this button can take the remainder of the card. */
const NEAR_W = 34;
const NEAR_GAP = 10;
const PILL_H = 32;
/** How far anything stacked ON TOP of this button has to clear it: its outer
 * height (2px of border) + the project's one 10px edge gap. Published as
 * `--ml-stack-step` below because THREE elements need it — this button, the
 * 🔍 beside it, and the pill above it — and the day the button's box changes,
 * three hardcoded copies would silently disagree. */
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
  :root{--ml-stack-step:${PILL_STEP}px}
  /* THE ROW IS THE CARD'S WIDTH, AND THIS BUTTON TAKES WHAT IS LEFT OF IT
     (maintainer 2026-09-19: "the wiki button should also align with the card
     over it… we want the search button to left align with the cards left edge
     and not the wiki button. But the wiki button should be wider and not the
     search button"). --bars-r-w is the XP card's measured width (hud.ts), NEAR_W
     the 🔍 square and NEAR_GAP the one gap between them, so the two together
     span exactly the card and the 🔍 lands on its left edge. The -2px is this
     button's own borders, outside a content-box width. */
  .ml-wikibtn{position:fixed;right:calc(var(--gv-right,0px) + 10px);
    bottom:calc(var(--hud-h, 38.2dvh) + 10px);z-index:8;
    width:calc(var(--bars-r-w, ${PILL_W + 2 + NEAR_W + NEAR_GAP}px) - ${NEAR_W + NEAR_GAP}px - 2px);
    height:${PILL_H}px;box-sizing:content-box;padding:0;
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
  /* RIGHT-HANDED LANDSCAPE: the same as portrait — this row directly under the
     XP chip, the pill one step below it. ONE ORDER ON BOTH SCREENS since
     2026-09-19, because the row has to TOUCH the card it is now as wide as. */
  :root.ml-land:not(.ml-lh) .ml-wikibtn{
    top:calc(var(--ml-safe-top, 0px) + var(--bars-r-h, 78px) + 20px);bottom:auto}
  /* PORTRAIT: THIS ROW IS DIRECTLY UNDER THE XP CHIP AND THE PILL HANGS ONE
     STEP BELOW IT. It was swapped to pill-first earlier on 2026-09-19 and
     swapped BACK the same day, and the second verdict carries its reason:
     "the wiki button should also align with the card over it… This also means
     we once again must place the wiki and search over the time-of-day pill."
     A row that is as wide as the card has to TOUCH the card, or the alignment
     it was given is invisible. The anchor is the same arithmetic either way —
     chip bottom + the 10px margin, --bars-r-h its measured height,
     --ml-safe-top the cutout inset it sits under — and only the
     ${PILL_STEP}px step moves between this row and the pill. */
  :root:not(.ml-land) .ml-wikibtn{
    top:calc(var(--ml-safe-top, 0px) + var(--bars-r-h, 78px) + 20px);bottom:auto}
  /* The keyboard lift: this row takes the line hud.ts clears above the keys,
     and the pill steps up over it exactly as it does at rest. */
  :root.ml-kb-up .ml-wikibtn{bottom:calc(var(--ml-inputlift) + 56px)}`;
  document.head.appendChild(s);
}

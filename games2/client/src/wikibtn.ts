/**
 * The in-game WIKI BUTTON (maintainer 2026-08-13): the wiki drawer used to be
 * reachable only from the select screen; in the world it gets a button in the
 * chrome, sized and anchored off the XP card it hangs from.
 *
 * WHERE THE ROW LIVES — two placements:
 * - PORTRAIT and RIGHT-HANDED LANDSCAPE: TOP-right, directly under the XP
 *   chip, as wide as it (maintainer 2026-09-19: "the wiki button should also
 *   align with the card over it"). A row as wide as the card has to TOUCH the
 *   card, or the alignment it was given is invisible. Top-anchored, so the
 *   keyboard lift below is over-constrained and ignored — the row is nowhere
 *   near the keys. The bottom corner is the ghost stick's (gamepad.ts) in
 *   portrait and the thumb stick's in landscape.
 * - LEFT-HANDED LANDSCAPE: the bottom corner is free (the stick is bottom-
 *   left), so this row takes the corner anchor, and the keyboard lift moves
 *   it.
 * THE TIME-OF-DAY PILL HANGS ONE --ml-stack-step UNDER THIS BUTTON, AS WIDE
 * AS IT (maintainer 2026-09-20: "once again place the time-of-day pill under
 * the wiki button and make it the same size as the wiki button … It doesn't
 * look good when it's at the top"). The dependency runs ONE way: clock.ts
 * measures this button's box and steps by the --ml-stack-step published
 * below; nothing here reads the pill's geometry, so the row moves the pill
 * and the pill can never move the row. (The two were a stack that moved
 * together from 2026-08-13, parted on 2026-09-19 when the pill went to the
 * top centre of the view, and are a stack again — this time the row leads.)
 *
 * Unlike the pill it is a real BUTTON (the pill is pass-through): it opens
 * the wiki drawer (wikipanel.ts), which now remembers where in the wiki you
 * were — see the spot store there.
 */

import { openWikiPanel } from "./wikipanel";
import { withV } from "./assetver";

// The pill's box as approved: 40x16 art pixels at x2 (clock.ts AW/AH/SCALE),
// content-box with a 1px border. PILL_H is this button's content height AND
// the pill's (AH x SCALE): the same height by construction, asserted against
// the REAL pill's rect by the gate. PILL_W is only the width fallback below —
// the pill's real width is THIS button's (clock.ts fitPill measures it).
const PILL_W = 80;
/** The 🔍 square beside it (wikinear.ts) and the one gap between them — the
 *  row's other two terms, so this button can take the remainder of the card. */
const NEAR_W = 34;
const NEAR_GAP = 10;
const PILL_H = 32;
/** How far anything stacked ON TOP OF OR UNDER this button has to clear it:
 * its outer height (2px of border) + the project's one 10px edge gap.
 * Published as `--ml-stack-step` below because THREE elements need it — this
 * button, the 🔍 beside it, and the pill under it — and the day the button's
 * box changes, three hardcoded copies would silently disagree. */
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
  /* THE STEP OTHER CHROME STACKS BY — this row's height plus the 10px margin
     everything keeps. Published from here because this row is the thing that
     defines it; read by anything that needs to sit a row away. */
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
    top:calc(var(--ml-safe-top, 0px) + var(--bars-r-h, 78px) + 20px);z-index:8;
    width:calc(var(--bars-r-w, ${PILL_W + 2 + NEAR_W + NEAR_GAP}px) - ${NEAR_W + NEAR_GAP}px - 2px);
    height:${PILL_H}px;box-sizing:content-box;padding:0;
    border:1px solid var(--border-strong);border-radius:7px;
    box-shadow:var(--shadow);cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:5px;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    font:600 12px var(--sans);letter-spacing:.03em;color:var(--ink);
    transition:right .3s ease,top .3s ease;
    -webkit-tap-highlight-color:transparent;user-select:none}
  .ml-wikibtn-icon{image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  .ml-wikibtn.press,.ml-wikibtn:active{transform:scale(.96)}
  /* ONE ANCHOR IN EVERY PLACEMENT: directly under the XP chip — chip bottom
     (--ml-safe-top the cutout inset it sits under, --bars-r-h its measured
     height) + the 10px margin — because the row has to TOUCH the card it is
     as wide as. Both orientations, both hands: left-handed landscape was the
     last placement to keep the game view's bottom corner instead (maintainer
     2026-09-19: "Left-handed landscape mode has still not placed the
     wiki+search under the XP-card"), and that corner holds no chrome since
     the pill hangs under this row instead (clock.ts). Both are top-anchored,
     so the keyboard lift (.ml-kb-up) has nothing of either to lift. */`;
  document.head.appendChild(s);
}

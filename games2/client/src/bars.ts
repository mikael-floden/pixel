/**
 * HP / Energy / XP bars + a Gold counter — HP + Energy top-LEFT, Experience
 * top-RIGHT, Gold UNDER Experience (maintainer 2026-07-23: "add a blue experience
 * bar to the right ... to the right of the clock"; "rename mana to energy"; "half
 * the current height"; "EP not MP"; 2026-07-24: "put the gold UI under the XP bar
 * so it aligns nicely with the energy bar").
 *
 * Art from his UI kit (scripts/bake-bars.py): bar-frame.png is the empty track;
 * bar-fill-{red,yellow,blue}.png are the same gold fill recoloured to a
 * health-red / energy-gold / experience-blue ramp, all in the kit palette. The
 * frame and fill are 9-SLICED into the box at the shared kit block scale
 * (plate.ts nineSlice / KIT_PX) so the bar keeps its size while its pixels match
 * the buttons; the fill stacks over the track and is CLIPPED left-to-right to
 * the percent (the dark interior shows through the cut). The layer is uiZoom'd
 * on <body> like the version badge, so it tracks the frame under "Desktop site".
 *
 * The GOLD counter is the NORTH-facing rotation of his "Gold" PixelLab object
 * (/ui2/gold-icon.png) with the amount to its left — both RIGHT-aligned to the XP
 * bar's right edge, so the row sits opposite the Energy bar (maintainer).
 *
 * The bars show STATIC placeholder values for now (maintainer 2026-07-23: HP
 * 10/10 full, Energy 0/0 empty, XP 0/10 empty — "don't want to see the animation
 * anymore") and gold shows 0; the number to the right shows the value.
 * setBar(kind, cur, max) / setGold(n) are the seams the real player state plugs
 * into later.
 */

import { applyUiZoom } from "./uiscale";
import { nineSlice } from "./plate";

const GAUGE_W = 258;
const GAUGE_H = 30; // HALF the old 60 (maintainer 2026-07-23: "half the height")
const NUM_PX = 22; // number font size, DESIGN px (decoupled from block scale)
const TOP = 108;
const GAP = 14; // between the HP and Energy rows on the left
// DESIGN-px anchors, tuned on the maintainer's phone view. LEFT clears the left
// vine rail; RIGHT (from the viewport's right edge) puts the Experience bar in
// the gap between the clock disc (ends ~x616) and the right vine rail (inner
// ~x900) — measured, ~13px clear on each side.
const LEFT = 90;
const RIGHT = 93;

type Kind = "hp" | "ep" | "xp";
interface Bar {
  fill: HTMLImageElement;
  num: HTMLElement;
  max: number;
  suffix: string;
}

let root: HTMLDivElement | null = null; // left group: HP + Energy
let rootR: HTMLDivElement | null = null; // right group: Experience + Gold
const bars: Record<Kind, Bar> = {} as any;
let goldNumEl: HTMLElement | null = null; // the gold amount label
let gold = 0; // how much gold the player has (0 until real state is wired)

export function mountBars() {
  if (root) return;
  injectStyles();
  root = document.createElement("div");
  root.className = "ml-bars";
  root.style.top = `${TOP}px`;
  root.style.left = `${LEFT}px`;
  rootR = document.createElement("div");
  rootR.className = "ml-bars";
  rootR.style.top = `${TOP}px`;
  rootR.style.right = `${RIGHT}px`;

  const make = (
    container: HTMLElement,
    kind: Kind,
    colour: string,
    max: number,
    suffix: string,
  ): Bar => {
    const row = document.createElement("div");
    row.className = "ml-bar-row";
    const gauge = document.createElement("div");
    gauge.className = "ml-bar-gauge";
    const frame = img("/ui2/bar-frame.png");
    const fill = img(`/ui2/bar-fill-${colour}.png`);
    fill.classList.add("ml-bar-fill");
    fill.dataset.color = colour; // HP=red / EP=yellow / XP=blue (gate checks this)
    gauge.append(frame, fill);
    const num = document.createElement("span");
    num.className = "ml-bar-num";
    row.append(gauge, num);
    container.appendChild(row);
    return { fill, num, max, suffix };
  };
  bars.hp = make(root, "hp", "red", 10, "HP");
  bars.ep = make(root, "ep", "yellow", 0, "EP");
  bars.xp = make(rootR, "xp", "blue", 10, "XP");

  // Gold counter UNDER the Experience bar (maintainer 2026-07-24). Not a gauge:
  // the north-facing "Gold" nugget icon at the RIGHT, its amount RIGHT-aligned
  // just to its left, the row the same width as the bar so its right edge lines
  // up with XP — and, as the 2nd row on the right, it sits opposite the Energy
  // bar (2nd row on the left).
  const goldRow = document.createElement("div");
  goldRow.className = "ml-gold-row";
  goldNumEl = document.createElement("span");
  goldNumEl.className = "ml-gold-num";
  const goldIcon = document.createElement("img");
  goldIcon.className = "ml-gold-icon";
  goldIcon.src = "/ui2/gold-icon.png";
  goldIcon.alt = "";
  goldIcon.draggable = false;
  goldRow.append(goldNumEl, goldIcon); // amount left, icon right (both flush right)
  rootR.appendChild(goldRow);

  document.body.append(root, rootR);
  applyUiZoom(root);
  applyUiZoom(rootR);
  renderGold();

  // Static placeholder values — no animation (maintainer 2026-07-23: "set hp to
  // stable 10/10, energy to 0/0 empty, xp to 0/10 also empty; don't want to see
  // the animation anymore"). setBar() replaces these once real state is wired.
  apply("hp", 1); // 10 / 10 — full
  apply("ep", 0); // 0 / 0  — empty
  apply("xp", 0); // 0 / 10 — empty
}

function apply(kind: Kind, pct: number) {
  const b = bars[kind];
  b.fill.style.clipPath = `inset(0 ${((1 - pct) * 100).toFixed(2)}% 0 0)`;
  const cur = Math.round(pct * b.max);
  b.num.textContent = `${cur} / ${b.max} ${b.suffix}`;
}

/** The seam the real player state plugs into. */
export function setBar(kind: Kind, cur: number, max: number) {
  if (!root) return;
  bars[kind].max = max;
  apply(kind, max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0);
}

function renderGold() {
  if (goldNumEl) goldNumEl.textContent = gold.toLocaleString("en-US");
}

/** The seam the real player gold plugs into (0 until wired to server state). */
export function setGold(n: number) {
  gold = Math.max(0, Math.round(n) || 0);
  renderGold();
}

function img(src: string): HTMLImageElement {
  const e = document.createElement("img");
  e.alt = "";
  e.draggable = false;
  // 9-slice the low-res kit bar art into the SAME box at the kit block scale
  // (plate.ts nineSlice / KIT_PX) so the bar keeps its size while its pixels
  // shrink to match the buttons — scaling the whole <img> coupled size to grain
  // and read ~2x the icons (maintainer 2026-07-23: "do what we did with the UI
  // KIT buttons"). scale=1: an <img> upscales itself crisply with
  // image-rendering:pixelated (kept in the CSS).
  const s = new Image();
  s.onload = () => {
    const u = nineSlice(s, GAUGE_W, GAUGE_H, 1);
    if (u) e.src = u;
  };
  s.src = src;
  return e;
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const w = GAUGE_W;
  const h = GAUGE_H;
  const s = document.createElement("style");
  s.textContent = `
  .ml-bars{position:fixed;z-index:8;pointer-events:none;display:flex;
    flex-direction:column;gap:${GAP}px}
  /* each row stacks the gauge over its number; row width = gauge width so the
     number RIGHT-aligns to the bar's right edge (maintainer 2026-07-23:
     "placed under and right aligned") */
  .ml-bar-row{display:flex;flex-direction:column;width:${w}px}
  .ml-bar-gauge{position:relative;width:${w}px;height:${h}px;flex:none}
  .ml-bar-gauge img{position:absolute;inset:0;width:100%;height:100%;
    image-rendering:pixelated;-webkit-user-drag:none}
  .ml-bar-fill{will-change:clip-path}
  .ml-bar-num{margin-top:4px;text-align:right;
    font:700 ${NUM_PX}px system-ui,sans-serif;letter-spacing:.5px;
    color:#f0e2c6;text-shadow:0 1px 2px #000,0 0 3px #000;white-space:nowrap}
  /* Gold row: amount then icon, BOTH flush to the right edge (= the bar's right
     edge, so it lines up with XP above and the Energy bar opposite). row width =
     bar width; justify-content:flex-end pins the [amount][icon] pair right.
     margin-top drops the row toward the Energy bar's NUMBER line: the Energy bar
     has its value UNDER the gauge, so the gold — a single line — must sink past
     the gauge to read as "on the same line" as that text (maintainer 2026-07-24:
     "account for that height as well"). Tuned on his phone view to sit a HAIR
     ABOVE that number line — sitting exactly on it read a touch too low ("a tiny
     bit up again, not as much as the original placement"). */
  .ml-gold-row{display:flex;justify-content:flex-end;align-items:center;gap:10px;
    width:${w}px;margin-top:22px}
  .ml-gold-num{font:700 ${NUM_PX}px system-ui,sans-serif;letter-spacing:.5px;
    color:#f0e2c6;text-shadow:0 1px 2px #000,0 0 3px #000;white-space:nowrap}
  .ml-gold-icon{height:36px;width:auto;image-rendering:pixelated;
    -webkit-user-drag:none;display:block}`;
  document.head.appendChild(s);
}

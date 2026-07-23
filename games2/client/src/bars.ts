/**
 * HP / Energy / XP bars — HP + Energy top-LEFT, Experience top-RIGHT (maintainer
 * 2026-07-23: "add a blue experience bar to the right ... to the right of the
 * clock"; "rename mana to energy"; "half the current height"; "EP not MP").
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
 * For now each fill sweeps so we can see the look ("connected to the players
 * real health ... but for now"); the number to the right tracks it. setBar(kind,
 * cur, max) is the seam the real player state plugs into later; it ends the demo.
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
let rootR: HTMLDivElement | null = null; // right group: Experience
const bars: Record<Kind, Bar> = {} as any;
let raf = 0;
let demo = true;

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
  bars.hp = make(root, "hp", "red", 500, "HP");
  bars.ep = make(root, "ep", "yellow", 500, "EP");
  bars.xp = make(rootR, "xp", "blue", 2000, "XP");
  document.body.append(root, rootR);
  applyUiZoom(root);
  applyUiZoom(rootR);

  demo = true;
  const t0 = performance.now();
  const loop = (t: number) => {
    // HP/Energy: triangle wave 0..1..0 over ~4.4s (energy half a period out of
    // phase so the two breathe independently). XP: fills UP like real experience
    // (sawtooth over ~10s) then rolls over — faked for now.
    const tri = (ph: number) => {
      const u = ((t - t0) / 4400 + ph) % 1;
      return u < 0.5 ? u * 2 : 2 - u * 2;
    };
    apply("hp", tri(0));
    apply("ep", tri(0.5));
    apply("xp", ((t - t0) / 10000) % 1);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}

function apply(kind: Kind, pct: number) {
  const b = bars[kind];
  b.fill.style.clipPath = `inset(0 ${((1 - pct) * 100).toFixed(2)}% 0 0)`;
  const cur = Math.round(pct * b.max);
  b.num.textContent = `${cur} / ${b.max} ${b.suffix}`;
}

/** The seam the real player state plugs into (ends the demo sweep). */
export function setBar(kind: Kind, cur: number, max: number) {
  if (!root) return;
  if (demo) {
    demo = false;
    cancelAnimationFrame(raf);
  }
  bars[kind].max = max;
  apply(kind, max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0);
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
    color:#f0e2c6;text-shadow:0 1px 2px #000,0 0 3px #000;white-space:nowrap}`;
  document.head.appendChild(s);
}

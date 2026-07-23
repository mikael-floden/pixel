/**
 * HP / MP bars — top-left of the game view (maintainer 2026-07-23, his
 * red/blue placement marks: "Red = Health, Blue = Mana").
 *
 * Art from his UI kit (scripts/bake-bars.py): /ui2/bar-frame.png is the empty
 * track; /ui2/bar-fill-red.png and -blue.png are the same gold fill recoloured
 * to a health-red / mana-blue luminance ramp. A fill stacks over the track and
 * is CLIPPED left-to-right to the percent (the dark interior shows through the
 * cut), so a bar is pure CSS over two <img>s — nearest-neighbour, integer
 * scale, no canvas.
 *
 * For now the fill sweeps 0%<->100% back and forth so we can see the look
 * ("connected to the players real health and mana ... but for now"), and the
 * number to the right tracks it ("300 / 500 HP"). setBar(kind, cur, max) is
 * the seam the real player state plugs into later; stopBarDemo() ends the
 * sweep. The layer is uiZoom'd on <body> like the version badge, so it tracks
 * the frame under "Desktop site".
 */

import { applyUiZoom } from "./uiscale";
import { nineSlice } from "./plate";

// The bar's DISPLAY box (CSS px) — the maintainer's tuned size, KEPT while the
// pixel blocks shrink: the low-res kit bar art (bar-*.png, 45x10) is 9-sliced
// into this box at the shared kit block scale (plate.ts nineSlice / KIT_PX),
// exactly like the buttons, so the bar stays this size but its pixels match
// them instead of reading ~2x the icons (maintainer 2026-07-23).
const GAUGE_W = 258;
const GAUGE_H = 60;
const NUM_PX = 22; // number font size, DESIGN px (decoupled from block scale)
// top-left anchor + row gap, DESIGN px (tuned on the maintainer's phone view).
// LEFT clears the frame's left vine rail (maintainer 2026-07-23: the bars were
// drawn OVER the frame); GAP separates the two bar+number groups.
const LEFT = 90;
const TOP = 108;
const GAP = 14;

type Kind = "hp" | "mp";
interface Bar {
  fill: HTMLImageElement;
  num: HTMLElement;
  max: number;
  suffix: string;
}

let root: HTMLDivElement | null = null;
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

  const make = (kind: Kind, colour: string, max: number, suffix: string): Bar => {
    const row = document.createElement("div");
    row.className = "ml-bar-row";
    const gauge = document.createElement("div");
    gauge.className = "ml-bar-gauge";
    const frame = img("/ui2/bar-frame.png");
    const fill = img(`/ui2/bar-fill-${colour}.png`);
    fill.classList.add("ml-bar-fill");
    fill.dataset.color = colour; // HP=red / MP=yellow (the gate checks this)
    gauge.append(frame, fill);
    const num = document.createElement("span");
    num.className = "ml-bar-num";
    row.append(gauge, num);
    root!.appendChild(row);
    return { fill, num, max, suffix };
  };
  bars.hp = make("hp", "red", 500, "HP");
  bars.mp = make("mp", "yellow", 500, "MP");
  document.body.appendChild(root);
  applyUiZoom(root);

  demo = true;
  const t0 = performance.now();
  const loop = (t: number) => {
    // triangle wave 0..1..0 over ~4.4s; mana half a period out of phase so the
    // two bars breathe independently
    const tri = (ph: number) => {
      const u = ((t - t0) / 4400 + ph) % 1;
      return u < 0.5 ? u * 2 : 2 - u * 2;
    };
    apply("hp", tri(0));
    apply("mp", tri(0.5));
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

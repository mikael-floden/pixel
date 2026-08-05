/**
 * HP / Energy / XP bars + LEVEL + Gold — HP + Energy top-LEFT, Experience
 * (with "LEVEL n" on its number line) + Gold top-RIGHT, floating over the
 * game view.
 *
 * WIKI-STYLE (maintainer 2026-07-30): the UI-kit bar art (bar-frame/fill
 * 9-slices) is gone. Each group sits in a translucent rounded CHIP (the
 * page theme's --bg at ~75%, blurred) so the text and tracks stay readable
 * over any world art, in light and dark theme alike; the gauges are slim
 * rounded tracks (surface-2 well + coloured fill). The gold nugget icon
 * (the maintainer's PixelLab art) STAYS — "not the icons".
 *
 * Gauge colours keep their meanings: HP red (--bad), Energy gold (--star),
 * XP blue (fixed #5f87c0 — the tokens carry no blue; it reads on both
 * themes). data-color hp=red / ep=yellow / xp=blue survives for the QA gate.
 *
 * The bars show STATIC placeholder values for now (HP 10/10 full, Energy 0/0
 * empty, XP 0/10 empty, gold 0, level 1); setBar(kind, cur, max) / setGold(n)
 * / setLevel(n) are the seams the real player state plugs into later.
 */

import { withV } from "./assetver";

type Kind = "hp" | "ep" | "xp";
interface Bar {
  fill: HTMLElement;
  num: HTMLElement;
  max: number;
  suffix: string;
}

let root: HTMLDivElement | null = null; // left chip: HP + Energy
let rootR: HTMLDivElement | null = null; // right chip: Experience + Gold
const bars: Record<Kind, Bar> = {} as any;
let goldNumEl: HTMLElement | null = null; // the gold amount label
let gold = 0; // how much gold the player has (0 until real state is wired)
let levelEl: HTMLElement | null = null; // the "LEVEL n" label on the XP row
let level = 1; // player level (1 until real state is wired)

export function mountBars() {
  if (root) return;
  injectStyles();
  root = document.createElement("div");
  root.className = "ml-bars";
  root.style.top = "10px";
  root.style.left = "10px";
  rootR = document.createElement("div");
  rootR.className = "ml-bars";
  rootR.style.top = "10px";
  rootR.style.right = "10px";

  const make = (container: HTMLElement, colour: string, max: number, suffix: string): Bar => {
    const row = document.createElement("div");
    row.className = "ml-bar-row";
    const gauge = document.createElement("div");
    gauge.className = "ml-bar-gauge";
    const fill = document.createElement("div");
    fill.className = "ml-bar-fill";
    fill.dataset.color = colour; // HP=red / EP=yellow / XP=blue (gate checks this)
    gauge.append(fill);
    const num = document.createElement("span");
    num.className = "ml-bar-num";
    row.append(gauge, num);
    container.appendChild(row);
    return { fill, num, max, suffix };
  };
  bars.hp = make(root, "red", 10, "HP");
  bars.ep = make(root, "yellow", 0, "EP");
  bars.xp = make(rootR, "blue", 10, "XP");

  // "LEVEL n" on the XP row's number line, LEFT-aligned opposite the
  // right-aligned XP count (maintainer 2026-07-25). Binds to the real player
  // level via setLevel().
  const xpRow = bars.xp.num.parentElement!;
  const numRow = document.createElement("div");
  numRow.className = "ml-bar-numrow";
  levelEl = document.createElement("span");
  levelEl.className = "ml-bar-level";
  xpRow.replaceChild(numRow, bars.xp.num);
  numRow.append(levelEl, bars.xp.num);

  // Gold under the Experience row (maintainer 2026-07-24): the nugget icon at
  // the RIGHT, the amount right-aligned just to its left.
  const goldRow = document.createElement("div");
  goldRow.className = "ml-gold-row";
  goldNumEl = document.createElement("span");
  goldNumEl.className = "ml-gold-num";
  const goldIcon = document.createElement("img");
  goldIcon.className = "ml-gold-icon";
  goldIcon.src = withV("/ui2/gold-icon.webp");
  goldIcon.alt = "";
  goldIcon.draggable = false;
  goldRow.append(goldNumEl, goldIcon); // amount left, icon right (both flush right)
  rootR.appendChild(goldRow);

  document.body.append(root, rootR);
  renderGold();
  renderLevel();

  // Static placeholder values (maintainer 2026-07-23: HP 10/10 full, Energy
  // 0/0 empty, XP 0/10 empty; no animation). setBar() replaces these once
  // real state is wired.
  apply("hp", 1); // 10 / 10 — full
  apply("ep", 0); // 0 / 0  — empty
  apply("xp", 0); // 0 / 10 — empty
}

function apply(kind: Kind, pct: number) {
  const b = bars[kind];
  b.fill.style.width = `${(pct * 100).toFixed(2)}%`;
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

function renderLevel() {
  if (levelEl) levelEl.textContent = `LEVEL ${level}`;
}

/** The seam the real player level plugs into (1 until wired to server state). */
export function setLevel(n: number) {
  level = Math.max(1, Math.round(n) || 1);
  renderLevel();
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const s = document.createElement("style");
  s.textContent = `
  /* a translucent theme chip so the group reads over any world art */
  .ml-bars{position:fixed;z-index:8;pointer-events:none;display:flex;
    flex-direction:column;gap:7px;padding:8px 10px;border-radius:12px;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    border:1px solid color-mix(in srgb, var(--border) 65%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}
  .ml-bar-row{display:flex;flex-direction:column;width:126px}
  .ml-bar-gauge{position:relative;width:100%;height:10px;border-radius:999px;
    background:var(--surface-2);border:1px solid var(--border);
    overflow:hidden;box-sizing:border-box}
  .ml-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px}
  .ml-bar-fill[data-color=red]{background:var(--bad)}
  .ml-bar-fill[data-color=yellow]{background:var(--star)}
  .ml-bar-fill[data-color=blue]{background:#5f87c0}
  .ml-bar-num{margin-top:2px;text-align:right;
    font:600 11px/1.3 var(--sans);letter-spacing:.02em;
    color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
  /* XP row only: "LEVEL n" LEFT + the XP count RIGHT share one line */
  .ml-bar-numrow{margin-top:2px;display:flex;justify-content:space-between;
    align-items:baseline;width:100%;gap:10px}
  .ml-bar-numrow .ml-bar-num{margin-top:0}
  .ml-bar-level{font:600 11px/1.3 var(--sans);letter-spacing:.04em;
    color:var(--muted);white-space:nowrap;text-align:left}
  /* Gold: amount then the nugget icon, both flush right */
  .ml-gold-row{display:flex;justify-content:flex-end;align-items:center;gap:6px;width:100%}
  .ml-gold-num{font:600 12px/1.2 var(--sans);color:var(--ink);
    font-variant-numeric:tabular-nums;white-space:nowrap}
  .ml-gold-icon{height:16px;width:auto;image-rendering:pixelated;
    -webkit-user-drag:none;display:block}
  @media (min-width:700px){ .ml-bar-row{width:170px} }`;
  document.head.appendChild(s);
}

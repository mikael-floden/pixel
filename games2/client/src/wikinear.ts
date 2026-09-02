/**
 * The 🔍 button — "what am I standing next to?" (maintainer 2026-09-02: "To
 * the left of the Wiki in-game button will be a square search icon that will
 * also take you to the wiki, but will go directly to the search with the
 * results sorted by how far away they are from the player. This is a way to
 * fast find what you stand next to.")
 *
 * Two halves, one contract — `games2/spec/WIKI_NEAR.md`. This side: a
 * pill-high SQUARE stacked left of the Wiki button (same anchors as
 * wikibtn.ts, one button-width plus the 10px gap further from the edge, so the
 * three — pill, Wiki, 🔍 — move as one stack through every placement and the
 * keyboard lift); on tap it opens the drawer on `#/near` and, the moment the
 * wiki has loaded, posts a `wiki:near` snapshot of everything around the
 * player by the wiki's OWN ids, nearest first. The wiki agent's side renders
 * it as search results sorted by distance.
 *
 * The snapshot comes from WorldScene's `__ml.nearby()` — the scene owns the
 * bodies, the drops, the scenery and the ground, so the enumeration lives
 * there; this module only asks, sorts nothing (the probe already did), and
 * talks to the iframe. It is taken AFTER the loop is frozen (wikipanel
 * freezes first), so it cannot go stale while the player reads, and it is
 * re-sent whenever the wiki asks (`wiki:wantNear` — a route reached by
 * navigation, a reload) for as long as the drawer is open.
 */

import { openWikiPanel } from "./wikipanel";

const NEAR_HASH = "#/near";
// The Wiki button's box (wikibtn.ts): 80x32 content + 1px border. The square
// is the pill's HEIGHT on both sides and sits one Wiki-button width + the
// project's 10px gap further in from the edge. The gate asserts all of it
// against the real neighbours' rects, never against these numbers.
const PILL_H = 32;
const WIKI_W = 80;
const STEP_X = WIKI_W + 2 + 10; // 92
const PILL_STEP = PILL_H + 2 + 10; // 44 — the Wiki button's own lift over the pill

type NearSnapshot = {
  world: string | null;
  at: { col: number; row: number } | null;
  radius: number;
  items: Array<{ domain: string; id: string; dist: number; n: number; path?: string }>;
};

let root: HTMLButtonElement | null = null;
let openFrame: HTMLIFrameElement | null = null;
let listening = false;

/** The snapshot, or an honest "no world" when there is no scene (the select
 * screen, a scene mid-rebuild). Never throws — a reply is always sent. */
function snapshot(): NearSnapshot {
  const ml = (window as unknown as { __ml?: { nearby?: (r?: number) => NearSnapshot } }).__ml;
  try {
    const s = ml && typeof ml.nearby === "function" ? ml.nearby() : null;
    if (s && Array.isArray(s.items)) return s;
  } catch {}
  return { world: null, at: null, radius: 0, items: [] };
}

function post(frame: HTMLIFrameElement): void {
  const cw = frame.contentWindow;
  if (!cw) return;
  cw.postMessage({ type: "wiki:near", ...snapshot() }, location.origin);
}

/** Answer `wiki:wantNear` from whichever wiki iframe is currently up — the
 * one opened here OR by the Wiki button (a player can navigate to #/near
 * from anywhere in the wiki, and the page asks on route). Idempotent, and
 * mounted by the SELECT screen too, so a #/near reached before there is a
 * world gets the honest `world: null, items: []` the spec promises rather
 * than silence. */
export function listenWikiNear(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    if ((e.data as { type?: string } | null)?.type !== "wiki:wantNear") return;
    const frame = document.querySelector<HTMLIFrameElement>(".ml-wikipanel iframe");
    if (!frame || e.source !== frame.contentWindow) return;
    post(frame);
  });
}

export function openWikiNear(): void {
  listenWikiNear();
  const frame = openWikiPanel({ hash: NEAR_HASH });
  if (!frame) return; // already open — the wiki's own nav can reach #/near
  openFrame = frame;
  // The FIRST load only. The wiki is hash-routed, so in-wiki navigation never
  // fires `load` again; a later return to #/near asks with wiki:wantNear.
  frame.addEventListener("load", () => { if (openFrame === frame) post(frame); }, { once: true });
}

export function mountWikiNearButton(): void {
  document.querySelectorAll(".ml-wikinear").forEach((e) => e.remove());
  injectStyles();
  listenWikiNear();
  root = document.createElement("button");
  root.className = "ml-wikinear";
  root.type = "button";
  root.title = "What am I standing next to? — the wiki, sorted by distance";
  root.setAttribute("aria-label", "What is near me");
  root.innerHTML = `<span class="ml-wikinear-icon">&#128269;</span>`;
  root.addEventListener("click", () => openWikiNear());
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
  /* The Wiki button's rules (wikibtn.ts), one STEP_X further from the right
     edge, and a square — the pill's height on both sides. */
  .ml-wikinear{position:fixed;right:calc(var(--gv-right,0px) + 10px + ${STEP_X}px);
    bottom:calc(var(--hud-h, 38.2dvh) + 10px + ${PILL_STEP}px);z-index:8;
    width:${PILL_H}px;height:${PILL_H}px;box-sizing:content-box;padding:0;
    border:1px solid var(--border-strong);border-radius:7px;
    box-shadow:var(--shadow);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    background:color-mix(in srgb, var(--bg) 76%, transparent);
    backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);
    color:var(--ink);transition:bottom .15s ease-out,right .3s ease,top .3s ease;
    -webkit-tap-highlight-color:transparent;user-select:none}
  .ml-wikinear-icon{font-size:16px;line-height:1}
  .ml-wikinear.press,.ml-wikinear:active{transform:scale(.96)}
  :root.ml-land:not(.ml-lh) .ml-wikinear{
    top:calc(var(--bars-r-h, 78px) + 20px + ${PILL_STEP}px);bottom:auto}
  :root.ml-kb-up .ml-wikinear{bottom:calc(var(--ml-inputlift) + 56px + ${PILL_STEP}px)}`;
  document.head.appendChild(s);
}

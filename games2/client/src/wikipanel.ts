// The in-game WIKI DRAWER (wiki agent's module — board: coordination/wiki.json).
//
// The wiki must feel like part of the game, not a link that kicks the player
// out to a browser tab (maintainer 2026-07-30). openWikiPanel() slides the
// wiki in from the LEFT over the current screen; the strip of game left
// visible on the right is darkened and acts as the close button (tap the
// game to go back). Escape closes too. The panel hosts the real wiki page
// (/assets/wiki/site/) in a same-origin iframe, so it is always the deployed
// wiki and the admin session (localStorage) is shared with the full-page
// version.
//
// Scale: the maintainer's phone browses with "Desktop site" ON — a 980px
// virtual viewport squeezed onto a ~393px screen (see uiscale.ts). An iframe
// inherits NONE of the page's zoom compensation: left alone it would lay the
// wiki out ~860 CSS px wide and render it at ~0.4x physical — unreadable.
// So the iframe is laid out at the panel's PHYSICAL width (panel CSS px ÷
// desktop-site factor) and transform-scaled back up — the wiki then renders
// its own proper mobile layout at true device resolution, exactly like it
// does in a real tab. Device-width phones and desktops have factor 1 and
// are untouched.
//
// The HUD can reuse this: import { openWikiPanel } from "./wikipanel" and
// call it from a menu button — nothing here is select-screen specific.

import { gameAudio } from "../../composer/index";

let root: HTMLDivElement | null = null;
let onResize: (() => void) | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;
let onMsg: ((e: MessageEvent) => void) | null = null;
let onTheme: (() => void) | null = null;
let menuOpen = false; // the wiki's OWN nav drawer inside the iframe

// TEMPORARY game-audio mute while auditioning wiki sounds (maintainer
// 2026-07-30): the wiki's Sounds/Music pages post {type:"wiki:muteGame", on}
// and we flip the composer's sound+music switches — remembering which ones WE
// flipped so closing the drawer (or leaving the page: the toggles persist to
// localStorage) restores exactly the player's own settings. Never touches a
// switch the player already had off.
let mutedByWiki: { sound: boolean; music: boolean } | null = null;
function setGameMuted(on: boolean): void {
  if (on && !mutedByWiki) {
    mutedByWiki = { sound: gameAudio.soundEnabled, music: gameAudio.musicEnabled };
    if (gameAudio.soundEnabled) gameAudio.toggleSound();
    if (gameAudio.musicEnabled) gameAudio.toggleMusic();
    window.addEventListener("pagehide", restoreGameAudio);
  } else if (!on) {
    restoreGameAudio();
  }
}
function restoreGameAudio(): void {
  if (!mutedByWiki) return;
  if (mutedByWiki.sound && !gameAudio.soundEnabled) gameAudio.toggleSound();
  if (mutedByWiki.music && !gameAudio.musicEnabled) gameAudio.toggleMusic();
  mutedByWiki = null;
  window.removeEventListener("pagehide", restoreGameAudio);
}

const PANEL_FRAC = 0.88;      // leave ≥~45 physical px of game visible
const PANEL_MAX_CSS = 1200;   // cap on big desktops — a wall of wiki looks broken
const ANIM_MS = 280;

function ensureCss(): void {
  if (document.getElementById("ml-wikipanel-css")) return;
  const s = document.createElement("style");
  s.id = "ml-wikipanel-css";
  s.textContent = `
  .ml-wikiroot{position:fixed;inset:0;z-index:5000}
  .ml-wikiback{position:absolute;inset:0;background:rgba(8,6,3,0);
    transition:background ${ANIM_MS}ms ease;cursor:pointer}
  .ml-wikiback.on{background:rgba(8,6,3,.62)}
  /* The wiki's own nav is open: the game strip double-darkens — one more
     "layer back". Tapping it then closes the MENU, not the wiki. */
  .ml-wikiback.on.deep{background:rgba(8,6,3,.85)}
  .ml-wikipanel{position:absolute;top:0;left:0;height:100%;
    background:var(--bg, #faf9f5);box-shadow:6px 0 28px rgba(0,0,0,.45);
    transform:translateX(-102%);transition:transform ${ANIM_MS}ms cubic-bezier(.22,.61,.36,1);
    overflow:hidden}
  .ml-wikipanel.on{transform:translateX(0)}
  .ml-wikipanel iframe{border:0;display:block;background:var(--bg, #faf9f5);transform-origin:top left}
  @media (prefers-reduced-motion: reduce){
    .ml-wikiback,.ml-wikipanel{transition:none}
  }`;
  document.head.appendChild(s);
}

/** Desktop-site squeeze factor: >1 only when a phone lays out a 980px page. */
function dsFactor(): number {
  const sw = window.screen?.width || window.innerWidth;
  return Math.max(1, window.innerWidth / Math.max(1, sw));
}

function layout(panel: HTMLDivElement, frame: HTMLIFrameElement): void {
  const f = dsFactor();
  // The px cap is in PHYSICAL terms — scale it into layout px by f so the
  // desktop-site phone (whose CSS px are ~0.4 physical) isn't capped early.
  const panelW = Math.min(Math.round(window.innerWidth * PANEL_FRAC), Math.round(PANEL_MAX_CSS * f));
  panel.style.width = `${panelW}px`;
  // Lay the wiki out at physical size, scale back to fill the panel.
  frame.style.width = `${Math.ceil(panelW / f)}px`;
  frame.style.height = `${Math.ceil(window.innerHeight / f)}px`;
  frame.style.transform = f > 1 ? `scale(${f})` : "";
}

export function openWikiPanel(): void {
  if (root) return; // already open
  ensureCss();
  root = document.createElement("div");
  root.className = "ml-wikiroot";
  const back = document.createElement("div");
  back.className = "ml-wikiback";
  back.title = "Back to the game";
  const panel = document.createElement("div");
  panel.className = "ml-wikipanel";
  const frame = document.createElement("iframe");
  frame.src = "/assets/wiki/site/index.html";
  frame.title = "Nangijala Wiki";
  panel.appendChild(frame);
  root.append(back, panel);
  document.body.appendChild(root);

  layout(panel, frame);
  onResize = () => { if (root) layout(panel, frame); };
  window.addEventListener("resize", onResize);
  // Nested-drawer rule (maintainer 2026-07-30): with the wiki's OWN menu
  // open, the first tap on the game (and Escape) closes the MENU — you stay
  // in the wiki; the next one closes the wiki. The wiki reports its menu
  // state via postMessage (same origin, source-checked).
  menuOpen = false;
  onMsg = (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
    const data = e.data as { type?: string; open?: boolean; on?: boolean };
    if (data?.type === "wiki:menu") {
      menuOpen = !!data.open;
      back.classList.toggle("deep", menuOpen);
    } else if (data?.type === "wiki:muteGame") {
      setGameMuted(!!data.on);
    }
  };
  window.addEventListener("message", onMsg);
  const backOut = () => {
    if (menuOpen) frame.contentWindow?.postMessage({ type: "wiki:closeMenu" }, location.origin);
    else closeWikiPanel();
  };
  onKey = (e) => { if (e.key === "Escape") backOut(); };
  window.addEventListener("keydown", onKey);
  back.addEventListener("click", backOut);

  // THEME LIVE-SYNC (maintainer 2026-07-30: one dark-theme choice flips both
  // the wiki and the game). The wiki reads localStorage["wiki-theme"] only at
  // boot, so when the GAME toggles while the drawer is open, mirror the new
  // data-theme straight onto the live iframe's root (same-origin — allowed).
  // theme.ts already wrote the localStorage key, so a reload stays consistent;
  // the reverse direction (wiki toggle → game) rides the storage event in
  // theme.ts. Applied once at load too, in case the iframe booted before a
  // toggle landed.
  onTheme = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const t = document.documentElement.dataset.theme;
    if (t) doc.documentElement.dataset.theme = t;
    else delete doc.documentElement.dataset.theme;
  };
  window.addEventListener("ml-theme", onTheme);
  frame.addEventListener("load", () => onTheme?.());

  // Two frames so the initial transform/opacity commit before animating in.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    back.classList.add("on");
    panel.classList.add("on");
  }));
}

export function closeWikiPanel(): void {
  if (!root) return;
  const r = root;
  root = null;
  if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
  if (onKey) { window.removeEventListener("keydown", onKey); onKey = null; }
  if (onMsg) { window.removeEventListener("message", onMsg); onMsg = null; }
  if (onTheme) { window.removeEventListener("ml-theme", onTheme); onTheme = null; }
  restoreGameAudio(); // leaving the wiki un-mutes the game (temporary by contract)
  menuOpen = false;
  r.querySelector(".ml-wikiback")?.classList.remove("on");
  r.querySelector(".ml-wikipanel")?.classList.remove("on");
  setTimeout(() => r.remove(), ANIM_MS + 40);
}

export const isWikiPanelOpen = (): boolean => !!root;

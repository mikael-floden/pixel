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
import { freezeGame, thawGame } from "./gamefreeze";

let root: HTMLDivElement | null = null;
let onResize: (() => void) | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;
let onPop: (() => void) | null = null;

// THE PHONE'S BACK GESTURE (maintainer 2026-08-13: "Opening the wiki and
// swipe back doesn't close the wiki. It exits the game").
//
// The drawer is not a page, so back had nothing of ours to pop and left the
// game outright. It owns exactly ONE history entry — the panel's — and a
// popstate here means that entry was popped: close the drawer, and the next
// back is the game's own to leave on.
//
// ONE entry, on purpose. Round one also pushed an entry for the wiki's side
// menu from HERE, and that is the bug the maintainer caught as "I definitely
// clicked on Overview! and the page didn't change!" (2026-08-14): same-origin
// frames share one joint session history, so the iframe's own navigations
// stack ON TOP of anything this window pushed — a nav click put the new page
// above the menu's entry, the menu-closed message made this window history.go(-1),
// and that popped the NAVIGATION, silently undoing the click. The parent can
// only ever pop safely when its own entry is the top one, which is exactly
// and only the panel's; the menu's entry lives in the wiki's own window now
// (wiki.js setMenu), where menu links can location.replace() it away.
//
// Hand-closing (strip tap, Escape) hands the entry back — but only AFTER the
// iframe is discarded: removing the iframe prunes its joint-history entries,
// which leaves the panel's sentinel as the current entry, so one silent
// history.back() lands on the game wherever the player had browsed. Popping
// before the prune would walk the wiki's history instead (the same class of
// bug as the menu one, from the other side).
let pendingCleanup: (() => void) | null = null;
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

// ── THE SPOT STORE (maintainer 2026-08-13: "the player comes back to where
// in the wiki the player was when the player closes the wiki and opens it
// again"). The wiki is hash-routed (#/monsters/…) with window scroll, so a
// spot is exactly {hash, scroll}. Saved when the drawer CLOSES; applied on
// the next open — the hash goes into the iframe src so the wiki boots
// straight onto the page, and the scroll is restored once the page is tall
// enough to hold it (the wiki fetches data.json before it renders, so the
// document is short for a beat and an immediate scrollTo would be clamped
// to nothing).
//
// IT LIVES EXACTLY AS LONG AS THE PLAYING SESSION — a module variable, no
// storage of any kind (maintainer 2026-08-14: "If I restart the game, the
// wiki should go back to overview when opened ofc. I said it should remember
// the page while playing and the user open and closes it. Not remembering it
// when I restart the entire game!"). It was localStorage, which outlives
// everything: reopening the app days later still dropped you into whatever
// monster you last read. A page load is precisely what a restart IS — boot,
// logout reload, reconnect fallback — so a variable that dies with the page
// draws the line in the one place that needs no upkeep and no expiry guess.
// The pagehide save went with it: writing a spot as the page dies only ever
// served the storage that is gone.
const SPOT_KEY = "ml-wiki-spot";
const WIKI_BASE = "/assets/wiki/site/index.html";
let openFrame: HTMLIFrameElement | null = null;
let spot: { hash: string; scroll: number } | null = null;
// Sweep the retired key once, so a player carrying an old stored spot is not
// left with a dead entry that nothing will ever read or clear.
try { localStorage.removeItem(SPOT_KEY); } catch { /* private mode */ }

function readSpot(): { hash: string; scroll: number } | null {
  // Still validated: the hash reaches an iframe src.
  if (!spot || !/^(#[\w\-/%.~]*)?$/.test(spot.hash)) return null;
  return spot;
}

function saveSpot(): void {
  const cw = openFrame?.contentWindow;
  try {
    if (!cw || !cw.location.pathname.startsWith("/assets/wiki/")) return;
    spot = { hash: cw.location.hash || "", scroll: Math.round(cw.scrollY || 0) };
  } catch { /* cross-origin (never, same-origin iframe) */ }
}

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
  /* Fallback is Canvas — the system's own page colour, which follows the
     phone's light/dark setting — not a hard-coded cream. If --bg were ever
     missing the old fallback painted a light panel behind a dark wiki, which
     is the flash the maintainer reported from the other side (2026-08-15). */
  .ml-wikipanel{position:absolute;top:0;left:0;height:100%;
    background:var(--bg, Canvas);box-shadow:6px 0 28px rgba(0,0,0,.45);
    transform:translateX(-102%);transition:transform ${ANIM_MS}ms cubic-bezier(.22,.61,.36,1);
    overflow:hidden}
  .ml-wikipanel.on{transform:translateX(0)}
  .ml-wikipanel iframe{border:0;display:block;background:var(--bg, Canvas);transform-origin:top left}
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

/** `hash` opens the wiki ON that route instead of the remembered spot (the
 * 🔍 button's `#/near` — spec/WIKI_NEAR.md); the remembered scroll is not
 * applied either, a fresh page starts at its top. Returns the iframe so the
 * caller can talk to it (`load`, postMessage); null when already open. */
export function openWikiPanel(opts: { hash?: string } = {}): HTMLIFrameElement | null {
  if (root) return null; // already open
  // A close still sliding out has not yet handed its history entry back —
  // flush it first, or that delayed back() would pop the entry THIS open is
  // about to push and shut the new drawer on arrival.
  pendingCleanup?.();
  // FREEZE THE WORLD FIRST (maintainer 2026-08-13: "the wiki lags a bit when
  // opened on top of the game — can you freeze or pause the game rendering
  // when the wiki is open?"). Before the iframe is even created, so the
  // heaviest moment — the wiki's own load and first layout — has the main
  // thread to itself. No-op on the select screen, where there is no game.
  // See gamefreeze.ts for what a sleeping loop does and does not stop.
  freezeGame();
  ensureCss();
  root = document.createElement("div");
  root.className = "ml-wikiroot";
  const back = document.createElement("div");
  back.className = "ml-wikiback";
  back.title = "Back to the game";
  const panel = document.createElement("div");
  panel.className = "ml-wikipanel";
  const frame = document.createElement("iframe");
  const start = opts.hash ? { hash: opts.hash, scroll: 0 } : readSpot();
  frame.src = WIKI_BASE + (start?.hash ?? "");
  frame.title = "Nangijala Wiki";
  openFrame = frame;
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
      // Mirror only — the menu's history entry is the WIKI's own business
      // (wiki.js setMenu). Touching history from here on this message is the
      // undone-Overview-click bug; see the note atop pendingCleanup.
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
  // A real back gesture landed on one of our entries: the browser has already
  // popped it, so peel one layer and never call history.go() here — that would
  // fight the player's own navigation.
  onPop = () => {
    // The panel's sentinel was popped by a real back gesture. While the menu
    // is open its own entry sits above this one inside the iframe, so this
    // normally never fires with menuOpen set — but if it somehow does, honour
    // the ladder anyway: shut the menu and re-arm, never skip a rung.
    if (menuOpen) {
      frame.contentWindow?.postMessage({ type: "wiki:closeMenu" }, location.origin);
      history.pushState({ mlWiki: true }, "");
    } else {
      closeWikiPanel({ fromBack: true });     // the entry popped itself
    }
  };
  window.addEventListener("popstate", onPop);
  // One entry for the panel itself, pushed LAST so it sits directly above the
  // game: everything the wiki pushes while the player browses stacks on top of
  // it, and back walks those wiki pages first, then this, then the game.
  history.pushState({ mlWiki: true }, "");

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
  // Restore the reading position on the FIRST load only — an in-wiki
  // navigation afterwards must land at ITS page top, not the old offset.
  let scrollRestored = false;
  frame.addEventListener("load", () => {
    onTheme?.();
    const want = start?.scroll ?? 0;
    if (scrollRestored || want <= 0) return;
    scrollRestored = true;
    const cw = frame.contentWindow;
    if (!cw) return;
    const t0 = performance.now();
    const tryScroll = () => {
      const doc = cw.document;
      if (!doc) return;
      const tall = (doc.scrollingElement?.scrollHeight ?? 0) >= want + cw.innerHeight;
      if (tall || performance.now() - t0 > 2500) cw.scrollTo(0, want);
      else requestAnimationFrame(tryScroll);
    };
    tryScroll();
  });

  // Two frames so the initial transform/opacity commit before animating in.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    back.classList.add("on");
    panel.classList.add("on");
  }));
  return frame;
}

export function closeWikiPanel(opts?: { fromBack?: boolean }): void {
  if (!root) return;
  if (onPop) { window.removeEventListener("popstate", onPop); onPop = null; }
  // Back to the world — and BEFORE the slide-out, not after it: wake() ticks a
  // frame synchronously, so the game is already repainted (and reading live
  // state again) while the drawer is still moving off, instead of a frozen
  // 280ms-old frame appearing behind it.
  thawGame();
  saveSpot(); // remember the page + scroll for the next open
  openFrame = null;
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
  // Remove the drawer after the slide-out — and only THEN hand the panel's
  // history entry back on a hand-close: discarding the iframe prunes its
  // joint-history entries, leaving our sentinel as the current entry, so one
  // silent back lands on the game no matter how far the player browsed. On a
  // back-gesture close the browser already popped it — touching history there
  // would drag the player somewhere they never asked to go.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    pendingCleanup = null;
    r.remove();
    if (!opts?.fromBack) history.back();
  };
  pendingCleanup = finish;
  setTimeout(finish, ANIM_MS + 40);
}

export const isWikiPanelOpen = (): boolean => !!root;

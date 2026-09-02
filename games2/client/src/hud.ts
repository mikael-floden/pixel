/**
 * Bottom HUD — WIKI-STYLE (maintainer 2026-07-30: "a complete UI/HUD remake
 * ... no UI Kit, no graphical game view frame. The entire UI should be
 * rebuilt in wiki style"). The vine/crystal page frame (frame2), the UI-kit
 * plates (plate.ts) and every sprite-based control are gone; the HUD is now
 * plain HTML/CSS on the shared wiki theme (theme.ts — the same tokens, fonts
 * and dark mode as wiki/site/wiki.css, one localStorage["wiki-theme"] flips
 * both).
 *
 * Layout: the golden-ratio split survives (game view = top 61.8%, HUD =
 * bottom 38.2%) but is plain CSS now; applyLayout() publishes --hud-h /
 * --hud-h-inv in REAL px on :root so the keyboard lift and the chat overlay
 * keep their px math. Pointer events in the HUD still never reach Phaser.
 * Nothing is zoom-compensated any more — like the wiki, the UI is plain
 * responsive CSS at any viewport width.
 */

import { mountGamepadStick } from "./gamepad";
import { mountBars } from "./bars";
import { mountWikiButton } from "./wikibtn";
import { mountWikiNearButton } from "./wikinear";
import { mountTheme, toggleTheme, currentTheme } from "./theme";
import { getHand, toggleHand, handLabel } from "./controls";
import { indoorLight, setIndoorLight } from "./indoorlight";
import { indoorWall, setIndoorWall, INDOOR_WALL_MIN, INDOOR_WALL_MAX } from "./indoorwall";
import { withV } from "./assetver";
import { minimapDotPct, mapImageUrls, type MinimapFeed } from "./maps";
import { gameAudio } from "../../composer/index";
import { MAX_CHAT_LEN } from "@nangijala/shared";

// ── Ambient-effect switches (Settings) ───────────────────────────────────
// The ambient-life agent (ambient/) exposes a per-effect TOGGLE controller on
// window.__mlAmbient: several COMPATIBLE effects can run at once, but an effect
// can't switch on while an incompatible one is active (each declares its
// `conflicts`). We render a checkbox list from it — data-driven, so a conflict
// the ambient agent adds/drops updates the UI with no code change here. See
// ambient/README.md "Toggling effects independently". Checkboxes are pure CSS
// now (.ml-amb-check + .on — the wiki look), no kit art.
type AmbientEffect = {
  name: string;
  kind: "field" | "episode";
  conflicts: string[];
  on: boolean; // running right now (AUTO: director/field; MANUAL: enabled)
  enabled: boolean; // manually switched on
  blocked: string | null; // the enabled effect that forbids switching this on
};
interface AmbientApi {
  effects: () => AmbientEffect[];
  toggle: (name: string) => { ok: boolean; blockedBy: string | null };
  setEnabled: (name: string, on: boolean) => { ok: boolean; blockedBy: string | null };
  auto: (on?: boolean) => "auto" | "manual";
  compatible: (a: string, b: string) => boolean;
  /** Bird DENSITY ratio (0.1×–10×, 1 = today's amount). No arg reads; a number
   * writes (clamped + persisted) and returns the stored value. Optional so an
   * older ambient layer without it degrades to "no slider". */
  birdDensity?: (v?: number) => number;
}
/** The ambient controller, or null if it hasn't mounted yet (or on the #map
 * preview where it never does). Everything reads through this so the switches
 * degrade gracefully — no ambient layer means no section, never an error. */
function ambientApi(): AmbientApi | null {
  const a = (window as unknown as { __mlAmbient?: Partial<AmbientApi> }).__mlAmbient;
  return a && typeof a.effects === "function" ? (a as AmbientApi) : null;
}
function ambSafe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
const capWords = (s: string) => s.replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
// Flip a CSS checkbox on/off (classList.toggle is already a no-op write when
// unchanged — the 700ms poll re-runs constantly while Settings is open).
function setCheck(box: HTMLElement, on: boolean) {
  box.classList.toggle("on", on);
}
// One shared refresh poll for the live ambient state (the director rolls
// episodes + fields gate on time-of-day, so the switches must track a moving
// target while Settings is open). Module-level so a HUD rebuild on re-join
// replaces it instead of leaking a second timer.
let ambPoll: ReturnType<typeof setInterval> | null = null;

/** Which map-image URL each world actually answered to (see updateMap).
 * Module-level so a HUD rebuild on rejoin doesn't re-probe. */
const mapImgUrl = new Map<string, string>();

/** A REAL touch device (a finger keyboard/thumbs are coming). Shared by the
 * chat keyboard lift and the landscape layout — under Chrome's "Request
 * Desktop Site" it reads false, which both consumers accept (no lift, no
 * landscape layout: the desktop-shaped page keeps the portrait split). */
function touchDevice(): boolean {
  return (
    (navigator.maxTouchPoints || 0) > 0 ||
    window.matchMedia?.("(pointer: coarse)").matches === true
  );
}

export interface HudActions {
  onLogout: () => void;
  /** Send a line from the Chat page's bottom input (same server path as the
   * on-screen chat box). */
  onChat: (text: string) => void;
  /** Settings-tab controls (the keyboard digits' mobile home). Entries with
   * `get` are SWITCHES: the plate renders pressed-down while get() is true
   * (down = ON, up = OFF — maintainer); plain entries are one-shot buttons.
   * The entry with `hook` keeps the .ml-hudbtn class the e2e smoke clicks. */
  settings: {
    label: string;
    act: () => void;
    hook?: boolean;
    get?: () => boolean;
    /** Live state printed on the button after the label (maintainer: the
     * buttons show their current state — "time-of-day: Day", "speed: x2"). */
    state?: () => string;
  }[];
  /** Backpack drag-out: an item slot was released over the GAME VIEW at
   * client coords (cx, cy) — the game converts to a world point and asks the
   * server to drop it there (clamped + ground-snapped server-side). `n` is
   * HOW MANY of the stack to drop (the quantity dialog's answer; 1 for a
   * lone item, which never opens the dialog). */
  onDropItem?: (slot: number, item: string, cx: number, cy: number, n: number) => void;
  /** A modal (the drop-quantity dialog) opened/closed. While locked the game
   * freezes movement — the chat-input pattern (Phaser keyboard off, which
   * also blocks the stick's synthesized keys; the dialog's own full-screen
   * backdrop swallows every tap before Phaser can see it). */
  onUiLock?: (locked: boolean) => void;
}

// Tab icons: the maintainer's 1x pixel-art set (client/ui-src/icons/, baked
// 2x by scripts/bake-tab-icons.py). GAMEPAD is FIRST by his order (2026-07-22
// — a new menu button; its page is bare until its content lands). Backpack
// stays the tab that opens selected.
const TABS = [
  { id: "gamepad", label: "Gamepad" },
  { id: "backpack", label: "Backpack" },
  { id: "equipment", label: "Equipment" },
  { id: "map", label: "Map" },
  { id: "settings", label: "Settings" },
  // Chat replaced Logout as a tab (maintainer 2026-07-23); Log out moved into
  // Settings. The chat page is empty for now.
  { id: "chat", label: "Chat" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Mount the in-game chrome: theme tokens, layout vars, stat bars. The name
 * survives from the frame era (WorldScene calls it once at join) but there is
 * NO page frame any more — the game view/HUD boundary is a plain 1px
 * var(--border) line drawn by the .ml-hud CSS. */
export function mountPageFrame() {
  injectStyles();
  mountBars(); // HP/EP/XP + gold + level, over the top of the game view
  mountWikiButton(); // the wiki drawer's opener, stacked with the clock pill
  mountWikiNearButton(); // 🔍 what am I standing next to — left of the Wiki button
  document.getElementById("ml-pageframe")?.remove(); // ancient overlay, if any
  // In the WORLD now: landscape becomes a real layout instead of the
  // "rotate your phone" prompt (index.html hides #ml-rotate under this
  // class). The title/select/loading screens never set it, so they keep
  // their portrait-only behavior (maintainer 2026-08-05).
  document.documentElement.classList.add("ml-ingame");
  // …and UNLOCK rotation for the installed app: main.ts locks "portrait" at
  // boot (the pre-game screens stay upright), so without this re-lock the
  // phone never rotates in the world at all — lock("any") overrides both
  // that and the manifest default. Rejects harmlessly in a browser tab
  // (rotation is native there). Logout reloads the page, so the boot-time
  // portrait lock returns for the select screen on the way out.
  (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("any")
    .catch(() => {});
  applyLayout();
  if (!layoutHooked) {
    layoutHooked = true;
    window.addEventListener("resize", applyLayout);
    window.addEventListener("ml-hand", applyLayout);
  }
}

let layoutHooked = false;
let lastLandState: boolean | null = null;
/** Cancels any orientation flip's veil cleanup in flight (bumped per flip). */
let flipToken = 0;

/** The live flip transition, if one is running. */
let flipCtl: {
  token: number;
  started: number;
  lastResize: number;
  lastFrame: number;
  calm: number;
  flushed: boolean;
} | null = null;

/** The theme-surface VEIL over the game view during a flip. The world canvas
 * cannot morph its aspect smoothly, and mid-rotation it shows either black
 * (buffer cleared) or a stale-sized frame — so it reloads DISCREETLY behind
 * the theme background while the chrome glides on top. z 3: above the
 * canvas, below the stick (4) / HUD column (4) / chat (5) / chips (8). */
let flipVeil: HTMLElement | null = null;

/** The orientation flip (maintainer 2026-08-05, five rounds — the arc
 * matters, do not relearn it):
 *  - Anchor-transition glides and a FLIP pin-then-glide were BOTH tried and
 *    both rejected. The final insight (round 5): Chrome/the OS already play
 *    their own rotation animation over the app's surface, so ANY chrome
 *    animation on top reads as a broken DOUBLE animation — "the menu shows
 *    up on the correct spot immediately and looks good", and the corner
 *    chrome must do the same. ORIENTATION SNAPS. The handedness glide
 *    (anchor transitions + the gamepad's .anim) is untouched — nothing else
 *    is moving during a hand switch, so it stays smooth and wanted.
 *  - What the flip DOES own is the heavy part (rounds 3-4): a real rotation
 *    restages the viewport several times, and a full scale.resize per stage
 *    — framebuffer realloc + whole-world redraw, back to back — stalls the
 *    main thread for seconds (the filmed stale letterboxed frames). So
 *    while the flip is live, :root.ml-flip suspends main.ts's fitCanvas and
 *    :root.ml-noanim freezes the anchor transitions (that is what makes the
 *    snap a SNAP); the game view sits behind a theme-surface veil; once
 *    resize events have been quiet ~300ms, ONE "ml-flip-flush" re-fits the
 *    canvas at its final size under the veil; and after two calm frames
 *    (hard cap 2.5s) the veil fades, revealing the freshly-sized world with
 *    every piece of chrome ALREADY at its final anchor. */
function beginFlip() {
  const now = performance.now();
  if (flipCtl) {
    // Rotation staged again (or rotated back) mid-transition: just keep the
    // transition open until the viewport truly settles.
    flipCtl.lastResize = now;
    flipCtl.flushed = false; // the final size changed again — re-flush at quiet
    return;
  }
  const token = ++flipToken;
  flipCtl = { token, started: now, lastResize: now, lastFrame: now, calm: 0, flushed: false };
  const root = document.documentElement;
  root.classList.add("ml-noanim");
  root.classList.add("ml-flip"); // suspends main.ts fitCanvas until the flush
  if (!flipVeil) {
    flipVeil = mk("div", "ml-flip-veil");
    document.body.appendChild(flipVeil);
  }
  flipVeil.style.opacity = "1";
  const step = (t: number) => {
    const c = flipCtl;
    if (!c || c.token !== token) return;
    // SETTLE — quiet resizes first, then ONE canvas flush, then calm frames.
    const dt = t - c.lastFrame;
    c.lastFrame = t;
    c.calm = dt < 34 ? c.calm + 1 : 0;
    const quiet = t - c.lastResize > 300;
    const capped = t - c.started > 2500;
    if (!c.flushed && (quiet || capped)) {
      // The viewport has stopped restaging: let the canvas take its final
      // size NOW, in one go, under the veil. This is the heavy frame —
      // framebuffer realloc + world redraw — so the calm counter resets and
      // the reveal waits for the frames after it.
      c.flushed = true;
      root.classList.remove("ml-flip");
      window.dispatchEvent(new Event("ml-flip-flush"));
      c.calm = 0;
    }
    if (c.flushed && ((c.calm >= 2 && t - c.started >= 120) || capped)) reveal();
    else requestAnimationFrame(step);
  };
  const reveal = () => {
    flipCtl = null;
    root.classList.remove("ml-noanim");
    root.classList.remove("ml-flip"); // belt — the flush path already did
    // the veil fades out, revealing the re-fitted world under chrome that is
    // already exactly where it belongs
    if (flipVeil) flipVeil.style.opacity = "0";
    const doneVeil = flipVeil;
    window.setTimeout(() => {
      if (token !== flipToken) return; // a newer flip owns the veil now
      if (doneVeil && doneVeil === flipVeil) {
        doneVeil.remove();
        flipVeil = null;
      }
    }, 450);
  };
  requestAnimationFrame(step);
}

/** Publish the layout in REAL px on :root. index.html's dvh CSS draws the
 * same portrait split; these px twins exist for the px consumers — the
 * keyboard lift's floor, the chat overlay's bottom anchor — which parseFloat
 * a px value (a raw "38.2dvh" string would read as 38.2).
 *
 * LANDSCAPE (maintainer 2026-08-05, in-game only, touch devices only): the
 * same golden-ratio split turned on its side — the game view keeps 61.8% of
 * the LONG axis and the menu takes the other 38.2% as a SIDE COLUMN. Which
 * side follows handedness (controls.ts): right-handed puts the menu LEFT so
 * the stick can live under the right thumb; left-handed mirrors. Everything
 * that anchors to the game view's edges reads the --gv-left/--gv-right px
 * insets published here (bars chips, chat overlay, clock pill, #game
 * itself), so the whole chrome re-anchors from one function — and because
 * those consumers transition their anchor properties, the swap glides.
 * Desktop (no touch) keeps the portrait split at any aspect — unchanged. */
function applyLayout() {
  const root = document.documentElement;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const land = root.classList.contains("ml-ingame") && touchDevice() && w > h;
  const left = getHand() === "left";
  // ORIENTATION changes run the flip (beginFlip above: veil + one canvas
  // resize, anchors snapping); handedness changes keep the plain anchor
  // transitions. Any FURTHER resize while the flip is live (real rotations
  // arrive in several stages) just refreshes its quiet-timer.
  if (lastLandState !== null && land !== lastLandState) beginFlip();
  else if (flipCtl) flipCtl.lastResize = performance.now();
  lastLandState = land;
  root.classList.toggle("ml-land", land);
  root.classList.toggle("ml-lh", left);
  if (land) {
    const menuW = Math.round(w * 0.382);
    root.style.setProperty("--menu-w", `${menuW}px`);
    // The game view runs the full height: consumers of --hud-h ("px above
    // the HUD rail") get 0 and land on the bottom edge, which is exactly
    // where the chat overlay and the clock pill belong in landscape.
    root.style.setProperty("--hud-h", `0px`);
    root.style.setProperty("--hud-h-inv", `${h}px`);
    root.style.setProperty("--gv-left", `${left ? 0 : menuW}px`);
    root.style.setProperty("--gv-right", `${left ? menuW : 0}px`);
  } else {
    const hudH = Math.round(h * 0.382);
    root.style.setProperty("--menu-w", `0px`);
    root.style.setProperty("--hud-h", `${hudH}px`);
    root.style.setProperty("--hud-h-inv", `${h - hudH}px`);
    root.style.setProperty("--gv-left", `0px`);
    root.style.setProperty("--gv-right", `0px`);
  }
  // THE LAYOUT IS PUBLISHED — everything that positions itself against
  // ml-land / the gv vars must run AFTER this, never on the raw resize.
  // gamepad.ts learned this the hard way: its own resize listener fires
  // BEFORE this one (mountPageFrame hooks resize at mountPageFrame() time,
  // which WorldScene calls AFTER new HudBar()), so it read a STALE ml-land
  // and skipped the landscape branch — leaving the floating stick parented
  // to a display:none page, 0×0 and unusable, until something else nudged
  // it. The hidden page never resizes, so its ResizeObserver could not heal
  // it either: rotating with any non-gamepad tab open lost the stick
  // entirely (maintainer 2026-08-05). Order-proof by construction now.
  window.dispatchEvent(new Event("ml-layout"));
}

export class HudBar {
  private pages = new Map<TabId, HTMLElement>();
  private invGrid: HTMLElement | null = null;
  private invItems: { item: string; n: number }[] = [];
  private activeDrag: { cancel: () => void } | null = null;
  /** Close hook for the open drop-quantity dialog (null = none open). */
  private qtyClose: (() => void) | null = null;
  private tabs = new Map<TabId, HTMLButtonElement>();
  private switches: [HTMLButtonElement, () => boolean][] = [];
  private stateful: [HTMLButtonElement, HudActions["settings"][number]][] = [];
  // ambient-effect checklist (populated once window.__mlAmbient is up)
  private ambSection: HTMLElement | null = null;
  private ambList: HTMLElement | null = null;
  private ambRows = new Map<string, { el: HTMLButtonElement; img: HTMLElement; label: HTMLElement }>();
  private ambAuto: { el: HTMLButtonElement; img: HTMLElement } | null = null;
  private ambBuilt = false;
  // Map tab: minimap <img> + a red "you are here" dot, driven by a rAF loop
  // that reads window.__ml.minimap() while the tab is visible.
  private mapEls: {
    wrap: HTMLElement; frame: HTMLElement; img: HTMLImageElement; dot: HTMLElement; empty: HTMLElement;
  } | null = null;
  private mapRaf: number | null = null;
  private mapSrcWorld = ""; // which world's minimap.png is currently loaded
  // Chat tab: a persistent history of the last CHAT_HISTORY_MAX log lines (the
  // SAME stream as the bottom-left log — system events + player chat, fed via
  // pushChat). Each carries its RECEIVE time so the page can print HH:MM and
  // draw a YYYY-MM-DD divider whenever the real-clock day changes.
  private chatMsgs: { name: string; text: string; t: Date }[] = [];
  private chatLogEl: HTMLElement | null = null;
  private chatShown = false; // is the Chat tab currently visible? (skip renders otherwise)

  constructor(private actions: HudActions) {
    injectStyles();
    document.querySelector(".ml-hud")?.remove(); // idempotent across re-joins
    // A stray quantity dialog from a torn-down HUD would hold a dead closure —
    // remove it like the gamepad clears its floating stick.
    document.querySelectorAll(".ml-qty-back").forEach((e) => e.remove());
    const hud = mk("div", "ml-hud");
    const tabRow = mk("div", "ml-tabrow");
    const pageWrap = mk("div", "ml-pages");

    for (const t of TABS) {
      const b = mk("button", "ml-tab") as HTMLButtonElement;
      b.dataset.tab = t.id;
      // icon only — no text label (maintainer 2026-07-18: "icon is enough");
      // the label lives on as the accessible name
      const icon = mk("img", "ml-tab-icon") as HTMLImageElement;
      icon.src = withV(`/ui2/icon-${t.id}.webp`);
      icon.alt = "";
      icon.draggable = false;
      // TRUE pixel scale (maintainer 2026-07-30: "icons isn't rendered in
      // pixel perfect scale"): the bakes are EXACT 2x of the maintainer's
      // authored 1x art on non-square canvases (~42-46 × 34-37) — a fixed
      // square box both distorted the aspect and landed on a fractional
      // scale. Render every icon at its authored grid: natural/2, per image.
      const fit = () => {
        if (!icon.naturalWidth) return;
        icon.style.width = `${icon.naturalWidth / 2}px`;
        icon.style.height = `${icon.naturalHeight / 2}px`;
      };
      icon.addEventListener("load", fit);
      fit();
      b.title = t.label;
      b.setAttribute("aria-label", t.label);
      b.append(icon);
      // audio comes from pressFx (down/up pair) — no extra click sound
      b.addEventListener("click", () => this.select(t.id));
      pressFx(b);
      tabRow.appendChild(b);
      this.tabs.set(t.id, b);

      const page = mk("div", "ml-page");
      page.dataset.page = t.id;
      pageWrap.appendChild(page);
      this.pages.set(t.id, page);
    }
    this.buildPages();

    hud.append(tabRow, pageWrap);
    // Android Chrome's long-press image detection hit-tests <img>s even
    // through pointer-events:none — suppress the context menu at the root or
    // holding a tab offers "download image" (maintainer, twice).
    hud.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.appendChild(hud);
    this.select("backpack");
    applyLayout(); // publish the px layout vars for the keyboard lift + chat

    // Keep the ambient switches tracking live state while Settings is open
    // (director rolls, fields gate on time-of-day). Replaces any prior timer
    // so a HUD rebuild on re-join never leaves two running.
    if (ambPoll) clearInterval(ambPoll);
    ambPoll = setInterval(() => this.tickAmbient(), 700);
  }

  private select(id: TabId) {
    for (const [tid, b] of this.tabs) b.classList.toggle("sel", tid === id);
    for (const [tid, p] of this.pages) p.classList.toggle("show", tid === id);
    // Build/refresh the ambient switches the moment Settings is opened (don't
    // wait up to a poll interval).
    if (id === "settings") this.tickAmbient();
    // The Map tab drives a live dot; only run its rAF loop while it's visible.
    if (id === "map") this.startMapLoop();
    else this.stopMapLoop();
    // Chat catches up any lines that arrived while it was hidden, and lands
    // scrolled to the newest.
    this.chatShown = id === "chat";
    if (this.chatShown) this.renderChat(true);
  }

  // ── Map tab ────────────────────────────────────────────────────────────
  /** Build the Map page: a fitted map <img> plus a red "you are here" dot
   * positioned by PERCENT via the world's own iso projection (so it stays
   * correct at any display size), over a fallback message for worlds that ship
   * no map image. The dot + image are driven by startMapLoop(). */
  private buildMap() {
    const page = this.pages.get("map")!;
    const wrap = mk("div", "ml-map");
    const frame = mk("div", "ml-map-frame");
    const img = mk("img", "ml-map-img") as HTMLImageElement;
    img.alt = "";
    img.draggable = false;
    const dot = mk("i", "ml-map-dot");
    frame.append(img, dot);
    const empty = mk("div", "ml-map-empty");
    empty.textContent = "No minimap for this world yet.";
    empty.hidden = true;
    wrap.append(frame, empty);
    page.append(wrap);
    // A real minimap loaded → size the frame to it and show it;
    // a 404 (world with no minimap.png) → fall back to the message.
    const showFallback = () => { frame.hidden = true; empty.hidden = false; };
    img.addEventListener("load", () => {
      // A real minimap → size the frame to it and show it. A 200 that isn't an
      // image (e.g. a dev-server SPA fallback for a missing minimap.png) fires
      // load with naturalWidth 0 — treat that as "no minimap" too, so the
      // fallback isn't limited to a hard 404.
      if (!img.naturalWidth || !img.naturalHeight) return showFallback();
      frame.hidden = false;
      empty.hidden = true;
      this.fitMap();
    });
    img.addEventListener("error", showFallback);
    this.mapEls = { wrap, frame, img, dot, empty };
    // Refit when the page window changes (orientation / frame recompose).
    new ResizeObserver(() => this.fitMap()).observe(wrap);
  }

  /** Size the minimap frame to fit its box while preserving the image's aspect
   * ratio, so the frame box EQUALS the displayed image and the dot's percent
   * offsets land on the right pixel (no letterbox skew). */
  private fitMap() {
    const els = this.mapEls;
    if (!els) return;
    const nw = els.img.naturalWidth, nh = els.img.naturalHeight;
    const box = els.wrap.getBoundingClientRect();
    if (!nw || !nh || box.width < 2 || box.height < 2) return;
    const ar = nw / nh;
    // LANDSCAPE (maintainer 2026-08-05: "the map should look the same size"
    // as portrait): size it as if the page were still the PORTRAIT page —
    // the short viewport side minus the page margins — and let the sides
    // overflow. The frame stays == the image box, so the "you are here"
    // dot's percent offsets keep landing on the right pixel; .ml-map is
    // overflow:hidden + centred, so the overhang clips evenly left and
    // right — and an iso minimap's left/right margins are open water.
    const land = document.documentElement.classList.contains("ml-land");
    let w = land ? Math.min(window.innerWidth, window.innerHeight) - 32 : box.width;
    let h = w / ar;
    if (h > box.height) { h = box.height; w = h * ar; }
    els.frame.style.width = `${Math.floor(w)}px`;
    els.frame.style.height = `${Math.floor(h)}px`;
  }

  private startMapLoop() {
    if (this.mapRaf != null) return;
    const tick = () => {
      // Self-heal: a reconnect builds a fresh HudBar and removes the old .ml-hud
      // from the DOM, but never calls the old instance's select() again — so
      // stop once our page has detached, instead of looping on a dead dot.
      if (!this.mapEls || !this.mapEls.wrap.isConnected) {
        this.stopMapLoop();
        return;
      }
      this.updateMap();
      this.mapRaf = requestAnimationFrame(tick);
    };
    this.mapRaf = requestAnimationFrame(tick);
  }

  private stopMapLoop() {
    if (this.mapRaf != null) {
      cancelAnimationFrame(this.mapRaf);
      this.mapRaf = null;
    }
  }

  /** One frame of the Map tab: (re)point the <img> at the current world's
   * minimap and move the dot to the player's cell. Reads the live scene feed
   * window.__ml.minimap() the same null-safe way the ambient switches do. */
  private updateMap() {
    const els = this.mapEls;
    if (!els) return;
    const ml = (window as unknown as { __ml?: { minimap?: () => MinimapFeed } }).__ml;
    const m = ml && typeof ml.minimap === "function" ? ml.minimap() : null;
    if (!m || !m.w || !m.h) return;
    // Load the world's map image once (and again if the world changed on
    // rejoin). WHICH FILE IS maps.ts's CALL, not the HUD's: the two map
    // renderers write two names in two trees (minimap.webp beside a world@1/@2
    // world, overview.webp beside a maps3 one) and `mapImageUrls` is the one
    // place that resolves it. The HUD only walks the candidates in order and
    // remembers which one this world answered to, so a miss costs at most one
    // request per world per session. No art domain needs a handshake with us.
    if (m.world && m.world !== this.mapSrcWorld) {
      this.mapSrcWorld = m.world;
      els.frame.hidden = false;
      els.empty.hidden = true;
      const img = els.img;
      const known = mapImgUrl.get(m.world);
      const tries = known ? [known] : mapImageUrls(m);
      let i = 0;
      const attempt = () => {
        // The LAST candidate leaves onerror null so buildMap's own error
        // listener shows the "no minimap" fallback.
        img.onerror = i + 1 < tries.length ? () => { i += 1; attempt(); } : null;
        img.onload = () => mapImgUrl.set(m.world, tries[i]);
        img.src = tries[i];
      };
      attempt();
    }
    // Dot at the player's cell, projected onto the ISO minimap. Percent of the
    // frame == percent of the image (the frame is fit to the image by fitMap).
    const [left, top] = minimapDotPct(m);
    els.dot.style.left = `${left.toFixed(3)}%`;
    els.dot.style.top = `${top.toFixed(3)}%`;
  }

  /** Re-read every switch's pressed state AND every live state label
   * (keyboard toggles + server syncs change them too). */
  refreshSettings() {
    for (const [b, get] of this.switches) b.classList.toggle("on", !!get());
    for (const [b, entry] of this.stateful)
      (b.firstElementChild ?? b).textContent = `${entry.label}: ${entry.state!()}`;
  }

  // ── Ambient-effect switches ────────────────────────────────────────────
  /** Called by the poll + on opening Settings: build the rows once the
   * ambient controller is up, then keep them in sync with live state. */
  private tickAmbient() {
    const st = this.pages.get("settings");
    if (!st || !st.classList.contains("show")) return; // only work while visible
    if (!this.ambBuilt) this.buildAmbient();
    else this.refreshAmbient();
  }

  private buildAmbient() {
    const list = this.ambList;
    const api = ambientApi();
    if (!list || this.ambBuilt || !api) return;
    const effects = ambSafe(() => api.effects(), [] as AmbientEffect[]);
    if (effects.length === 0) return; // controller up but not ready — retry
    this.ambBuilt = true;
    if (this.ambSection) this.ambSection.style.display = ""; // reveal now it has rows
    // AUTO first (the living-world default: director rolls, fields self-gate),
    // then one row per effect in registry order.
    this.ambAuto = this.ambRow(null, "Auto");
    for (const e of effects) this.ambRow(e.name, capWords(e.name));
    // Bird-density slider under the checklist — scales BOTH bird flocks 0.1×–10×
    // (maintainer 2026-07-25). Only when the ambient layer exposes birdDensity
    // (older layers degrade to no slider).
    const bd = api.birdDensity;
    if (this.ambSection && typeof bd === "function") {
      this.ambSection.appendChild(birdSlider(() => bd(), (v) => bd(v)));
    }
    this.refreshAmbient();
  }

  /** A checkbox row (wiki-style row button + CSS checkbox + label).
   * name=null → the AUTO row. Returns its element refs for state updates. */
  private ambRow(name: string | null, label: string) {
    const b = mk("button", "ml-plate-btn ml-amb-row") as HTMLButtonElement;
    if (name === null) b.classList.add("ml-amb-auto");
    const img = mk("span", "ml-amb-check");
    img.setAttribute("aria-hidden", "true");
    const t = mk("span", "ml-amb-label");
    t.textContent = label;
    b.append(img, t);
    b.addEventListener("click", () => this.onAmbient(name));
    pressFx(b);
    this.ambList!.appendChild(b);
    const refs = { el: b, img, label: t };
    if (name !== null) this.ambRows.set(name, refs);
    return refs;
  }

  /** Handle a row tap. AUTO toggles director mode; an effect toggles itself
   * (enabling refused when an incompatible effect is active). Tapping an
   * effect while in AUTO takes manual control while PRESERVING the scene the
   * director is currently showing, so only the tapped effect changes. */
  private onAmbient(name: string | null) {
    const api = ambientApi();
    if (!api) return;
    if (name === null) {
      const mode = ambSafe(() => api.auto(), "manual");
      ambSafe(() => api.auto(mode !== "auto"), "manual");
    } else {
      const effects = ambSafe(() => api.effects(), [] as AmbientEffect[]);
      const cur = effects.find((e) => e.name === name);
      if (cur?.blocked) return this.refreshAmbient(); // can't enable — no-op
      const mode = ambSafe(() => api.auto(), "manual");
      if (mode === "auto") {
        const running = effects.filter((e) => e.on).map((e) => e.name);
        const wasOn = !!cur?.on;
        ambSafe(() => api.auto(false), "manual"); // → manual, empty set
        // Apply the TAP first (guaranteed — the set is empty, nothing blocks
        // it), THEN re-seed the rest of the scene the director was showing so
        // only the tapped effect changed. Any seeded effect that conflicts
        // with the tap is silently refused (dropped) — e.g. tapping fireflies
        // during the day drops the running pollen (its day/night opposite).
        if (!wasOn) ambSafe(() => api.setEnabled(name, true), null);
        for (const r of running) if (r !== name) ambSafe(() => api.setEnabled(r, true), null);
      } else {
        ambSafe(() => api.toggle(name), null);
      }
    }
    this.refreshAmbient();
  }

  private refreshAmbient() {
    const api = ambientApi();
    if (!api || !this.ambBuilt) return;
    const mode = ambSafe(() => api.auto(), "manual");
    if (this.ambAuto) {
      const on = mode === "auto";
      this.ambAuto.el.classList.toggle("on", on);
      setCheck(this.ambAuto.img, on);
    }
    for (const e of ambSafe(() => api.effects(), [] as AmbientEffect[])) {
      const row = this.ambRows.get(e.name);
      if (!row) continue;
      row.el.classList.toggle("on", e.on); // on → the cream "selected" plate
      row.el.classList.toggle("blocked", !!e.blocked);
      setCheck(row.img, e.on);
      // when blocked, say which active effect forbids it
      const text = e.blocked ? `${capWords(e.name)} — ${capWords(e.blocked)} on` : capWords(e.name);
      if (row.label.textContent !== text) row.label.textContent = text;
    }
  }

  private buildPages() {
    // Gamepad: the on-screen analog stick (right-thumb spot the maintainer
    // marked). It synthesizes real WASD key events — movement identical to
    // the keyboard, jump button TBD.
    mountGamepadStick(this.pages.get("gamepad")!);

    // Backpack: the REAL inventory (server-owned, arrives as targeted "inv"
    // messages -> setInventory). 5-col grid, padded to at least 15 cells so
    // an empty pack still reads as the familiar wall of slots. A filled slot
    // DRAGS: pointer-captured ghost (the bird-density slider pattern);
    // releasing over the game view (top 61.8%) asks the game to drop it
    // there — releasing anywhere else snaps back.
    const bp = this.pages.get("backpack")!;
    this.invGrid = mk("div", "ml-slots");
    bp.append(this.invGrid);
    this.renderInventory();

    // Equipment page: bare stone until its real content lands
    // (maintainer 2026-07-17: no placeholder text).

    // Map page: the world's minimap with a live red player dot.
    this.buildMap();

    // Settings: home of ALL the toggles mobile can't reach by keyboard. The
    // page now stacks the games button grid OVER the ambient-effect checklist
    // inside one scrolling column (.ml-set) — with ~12 buttons + 8 effects it
    // overflows a phone, so .ml-page scrolls from the top (see injectStyles:
    // "safe center").
    const st = this.pages.get("settings")!;
    // Log out lives at the TOP of Settings now (maintainer 2026-07-23: moved off
    // its own tab, which Chat replaced). As a direct child of the settings
    // .ml-page it inherits the .ml-page>.ml-plate-btn WIDE full-row width — the
    // same width its old page gave it. Still a deliberate two-step (open Settings
    // then press), so a stray tap can't eject anyone.
    st.appendChild(plateButton("Log out", () => this.actions.onLogout()));
    const wrap = mk("div", "ml-set");
    const row = mk("div", "ml-btnrow");
    for (const t of this.actions.settings) {
      const b = plateButton(t.label, () => {
        t.act();
        this.refreshSettings();
      });
      if (t.hook) b.classList.add("ml-hudbtn"); // stable hook for the smoke
      if (t.get) this.switches.push([b, t.get]);
      if (t.state) this.stateful.push([b, t]);
      row.appendChild(b);
    }
    // THEME: the shared wiki/game dark-mode switch (maintainer 2026-07-30:
    // "changing to dark theme will affect both the wiki and the in-game
    // HUD"). Writes the same one localStorage key the wiki's ◐ toggle uses;
    // the label prints its state like every other settings button.
    const themeEntry: HudActions["settings"][number] = {
      label: "theme",
      act: () => toggleTheme(),
      state: () => currentTheme(),
    };
    const themeBtn = plateButton("theme", () => {
      themeEntry.act();
      this.refreshSettings();
    });
    this.stateful.push([themeBtn, themeEntry]);
    row.appendChild(themeBtn);
    // CONTROLS: right-handed (default) or left-handed — which side the
    // analog stick lives on, and in landscape which side the whole menu
    // column takes (maintainer 2026-08-05). controls.ts owns the state; the
    // "ml-hand" event re-anchors the layout (applyLayout) and the gamepad.
    const handEntry: HudActions["settings"][number] = {
      label: "controls",
      act: () => toggleHand(),
      state: () => handLabel(),
    };
    const handBtn = plateButton("controls", () => {
      handEntry.act();
      this.refreshSettings();
    });
    handBtn.classList.add("ml-handbtn"); // stable hook for the landscape gate
    this.stateful.push([handBtn, handEntry]);
    row.appendChild(handBtn);
    window.addEventListener("ml-hand", () => this.refreshSettings());
    // …and follow toggles from the WIKI side (its write → storage event →
    // theme.ts re-applies → "ml-theme") so the printed state never goes stale.
    window.addEventListener("ml-theme", () => this.refreshSettings());
    this.refreshSettings();
    wrap.appendChild(row);
    // The ambient agent injects its cycler button into this row from outside
    // (ambient/runtime/hudbutton.ts) as a bare-text .ml-plate-btn — the class
    // is pure CSS again (the wiki button recipe), so it dresses itself; only
    // wrap bare text labels in a <span> so the shared label styling applies.
    new MutationObserver(() => {
      row.querySelectorAll<HTMLElement>(".ml-plate-btn").forEach((el) => {
        if (!el.firstElementChild && el.textContent) {
          const t = mk("span", "");
          t.textContent = el.textContent;
          el.textContent = "";
          el.appendChild(t);
        }
      });
    }).observe(row, { childList: true });

    // INDOOR LIGHT: the base ambient inside houses and caves (maintainer
    // 2026-08-06: "a slider on the settings page … 0% = BLACK, 100% = THE TILE
    // WILL LOOK JUST LIKE THE PNG"). Lives on the Settings page proper, NOT in
    // the Ambient-effects section below — that section is the ambient agent's
    // and is built lazily from its registry. indoorlight.ts owns the value and
    // its persistence; the scene listens for "ml-indoor-light".
    wrap.appendChild(
      pctSlider("Indoor light", () => indoorLight(), (v) => setIndoorLight(v)),
    );

    // INDOOR WALL HEIGHT: how tall the walls stand while you are inside, in
    // levels ABOVE THE ROOM'S OWN FLOOR (maintainer 2026-08-07: "change the
    // logic and settings slider to select how high the walls should be measured
    // from the ground/floor and not from the roof (a cave might have higher to
    // the ceiling)"). STEPPED, because the underlying quantity is a whole number
    // of 16px levels — a continuous slider would show the same picture across a
    // third of its travel and then jump. indoorwall.ts owns the value and its
    // persistence; the scene rebuilds its mask on "ml-indoor-wall".
    const wallSpan = INDOOR_WALL_MAX - INDOOR_WALL_MIN;
    const p2wall = (p: number) => INDOOR_WALL_MIN + Math.round(p * wallSpan);
    const wall2p = (v: number) => (v - INDOOR_WALL_MIN) / wallSpan;
    wrap.appendChild(
      pctSlider("Indoor wall height", () => wall2p(indoorWall()), (p) => setIndoorWall(p2wall(p)), {
        snap: (p) => wall2p(p2wall(p)),
        format: (p) => `${p2wall(p)} level${p2wall(p) === 1 ? "" : "s"}`,
      }),
    );

    // Ambient-effect checklist: one checkbox row per effect (+ an AUTO row).
    // Rows are built lazily once window.__mlAmbient is up (tickAmbient); the
    // whole section stays hidden until then, so an absent/failed ambient layer
    // shows no empty header (graceful degradation — the ambient charter's rule).
    const amb = mk("div", "ml-amb");
    amb.style.display = "none";
    const title = mk("div", "ml-amb-title");
    title.textContent = "Ambient effects";
    const list = mk("div", "ml-amb-list");
    amb.append(title, list);
    wrap.appendChild(amb);
    this.ambSection = amb;
    this.ambList = list;
    st.appendChild(wrap);

    // Chat page: the persistent message history + a full-width input.
    this.buildChat();
  }

  // ── Chat tab ─────────────────────────────────────────────────────────────
  /** Build the Chat page: a scrolling message log over a full-width input bar.
   * The log mirrors the on-screen chat (system events + player chat) but keeps
   * history; the input sends through the same rate-limited server path. */
  private buildChat() {
    const page = this.pages.get("chat")!;
    const wrap = mk("div", "ml-chat");
    const log = mk("div", "ml-chat-log");
    this.chatLogEl = log;
    const bar = mk("div", "ml-chat-inputbar");
    const input = mk("input", "ml-chat-input") as HTMLInputElement;
    input.type = "text";
    input.maxLength = MAX_CHAT_LEN;
    input.placeholder = "say something…";
    input.setAttribute("aria-label", "Write a chat message");
    // enterkeyhint tells mobile keyboards to show a "send" affordance
    input.setAttribute("enterkeyhint", "send");
    input.addEventListener("keydown", (e) => {
      // While the box is focused, keep movement keys (WASD/Space) from leaking
      // through the DOM to Phaser's global keyboard — exactly like ChatUI.
      e.stopPropagation();
      if (e.key === "Enter") {
        const text = input.value.trim();
        if (text) this.actions.onChat(text);
        input.value = "";
      } else if (e.key === "Escape") {
        input.blur();
      }
    });
    bar.appendChild(input);
    wrap.append(log, bar);
    page.appendChild(wrap);
  }

  /** Append a log line to the persistent Chat history (called for EVERY line the
   * on-screen chat shows — system + player). Caps at CHAT_HISTORY_MAX, dropping
   * the oldest, and re-renders if the Chat tab is currently visible. */
  /** The server-owned backpack (targeted "inv" messages). Rerenders the grid. */
  setInventory(items: { item: string; n: number }[]) {
    this.invItems = Array.isArray(items) ? items : [];
    this.renderInventory();
  }

  /** QA probe: what the backpack currently shows. */
  invSnapshot(): { item: string; n: number }[] {
    return this.invItems.map((s) => ({ ...s }));
  }

  private renderInventory() {
    const grid = this.invGrid;
    if (!grid) return;
    // An "inv" refresh can land MID-DRAG (auto-pickup on arrival, a join
    // refresh): rebuilding the grid detaches the captured cell, whose
    // pointerup can then never fire — cancel the gesture explicitly or the
    // ghost sprite is orphaned on screen until reload.
    this.activeDrag?.cancel();
    grid.textContent = "";
    const total = Math.max(15, Math.ceil((this.invItems.length + 1) / 5) * 5);
    for (let i = 0; i < total; i++) {
      const entry = this.invItems[i];
      const cell = mk(entry ? "div" : "i", "ml-slot");
      if (entry) {
        cell.classList.add("filled");
        const img = document.createElement("img");
        img.src = `/assets/items/${entry.item}/sprite.webp`;
        img.alt = entry.item;
        img.draggable = false;
        cell.appendChild(img);
        // EVERY filled slot prints its count, ×1 included (maintainer
        // 2026-08-05: "'×1', '×2', '×3', etc") — lower-right corner badge.
        const badge = document.createElement("b");
        badge.textContent = `×${entry.n}`;
        cell.appendChild(badge);
        this.armSlotDrag(cell, img, i, entry.item, entry.n);
      }
      grid.appendChild(cell);
    }
  }

  /** Pointer-captured drag (the bird-density slider pattern): a ghost sprite
   * rides the finger; releasing over the game view (above the HUD line) hands
   * the client coords to the game, anywhere else snaps back. Capture keeps
   * every move/up on the slot element, so Phaser never sees the gesture and
   * cannot arm a move trip from it. */
  private armSlotDrag(cell: HTMLElement, img: HTMLImageElement, slot: number, item: string, count: number) {
    cell.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      this.activeDrag?.cancel(); // one gesture at a time
      cell.setPointerCapture(e.pointerId);
      let ghost: HTMLImageElement | null = null;
      const move = (ev: PointerEvent) => {
        if (!ghost) {
          ghost = img.cloneNode(true) as HTMLImageElement;
          ghost.className = "ml-slot-ghost";
          document.body.appendChild(ghost);
          cell.classList.add("dragging");
        }
        ghost.style.left = `${ev.clientX - 20}px`;
        ghost.style.top = `${ev.clientY - 20}px`;
      };
      const cleanup = () => {
        cell.removeEventListener("pointermove", move);
        cell.removeEventListener("pointerup", finish);
        cell.removeEventListener("pointercancel", cancel);
        cell.classList.remove("dragging");
        ghost?.remove();
        ghost = null;
        this.activeDrag = null;
      };
      const finish = (ev: PointerEvent) => {
        const dragged = !!ghost;
        cleanup();
        if (dragged) {
          // Over the GAME VIEW (top 61.8% — everything above the HUD's own
          // top edge) => drop it into the world at that point. The item id
          // rides along: slot indices go stale in flight when a stack
          // empties, and the server drops whatever the index NAMES NOW.
          const hudTop = window.innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hud-h")) || window.innerHeight * 0.382);
          // ALWAYS ask (maintainer 2026-08-05: "since this dialog acts as a
          // nice confirm dialog, we want it for dropping 1 item when you only
          // have ×1 as well") — a stack asks HOW MANY, a lone item asks
          // WHETHER. The dialog keeps the release point, so the eventual drop
          // lands where the finger let go.
          if (ev.clientY < hudTop) this.openDropQty(slot, item, count, ev.clientX, ev.clientY);
        }
      };
      const cancel = () => cleanup();
      cell.addEventListener("pointermove", move);
      cell.addEventListener("pointerup", finish);
      cell.addEventListener("pointercancel", cancel);
      this.activeDrag = { cancel: cleanup };
    });
  }

  /** The drop-quantity dialog (maintainer 2026-08-05, refined the same day):
   * EVERY backpack drag-out lands here first — a stack asks how many, a lone
   * item is a plain confirm. A wiki-style card centred in the GAME VIEW
   * (positioned off the layout vars, so it lands mid-view in portrait AND
   * landscape) over a DARKENING backdrop that swallows every pointer;
   * movement is frozen while it's open (onUiLock).
   *
   * ONE ROW of controls — item, −, the count, + — over a full-width DROP.
   * There is no cancel button and no max button (maintainer: "remove the close
   * button to make it cleaner… remove the MAX button"): tapping OUTSIDE the
   * card closes it, and −/+ WRAP AROUND, so one tap on − from ×1 is "all of
   * them". The count itself is TYPABLE on the numeric keyboard; junk in the
   * field never moves the amount. */
  private openDropQty(slot: number, item: string, max: number, cx: number, cy: number) {
    this.qtyClose?.(); // one dialog at a time
    const back = mk("div", "ml-qty-back");
    const card = mk("div", "ml-qty");
    const head = mk("div", "ml-qty-head");
    const img = document.createElement("img");
    img.src = `/assets/items/${item}/sprite.webp`;
    img.alt = item;
    img.draggable = false;

    // Inline stroke SVGs, not font glyphs: they inherit the theme ink via
    // currentColor and can't fall out of a phone font's coverage.
    const icon = (d: string) => {
      const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      s.setAttribute("viewBox", "0 0 20 20");
      s.setAttribute("aria-hidden", "true");
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", d);
      s.appendChild(p);
      return s;
    };
    const btn = (cls: string, label: string, d: string, act: () => void) => {
      const b = mk("button", `ml-plate-btn ml-qty-btn ${cls}`) as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("aria-label", label);
      b.title = label;
      b.appendChild(icon(d));
      b.addEventListener("click", act);
      return b;
    };
    let want = 1;
    // WRAP-AROUND (maintainer): past the top comes 1 again, below 1 comes the
    // whole stack — which is what replaced the max button.
    const dec = btn("ml-qty-dec", "fewer", "M5 10h10", () => {
      want = want <= 1 ? max : want - 1;
      paint();
    });
    const inc = btn("ml-qty-inc", "more", "M10 5v10M5 10h10", () => {
      want = want >= max ? 1 : want + 1;
      paint();
    });
    // The count is an INPUT: tap it and type the amount on the phone's number
    // keyboard (inputmode numeric + a digits-only pattern). It stays free-form
    // while focused so a field can be cleared mid-edit; only a whole number
    // inside 1..max moves `want`, and leaving the box repaints from `want` —
    // so "1e9", "abc" or an empty box leave the amount exactly as it was.
    const count = mk("input", "ml-qty-count") as HTMLInputElement;
    count.type = "text";
    count.inputMode = "numeric";
    count.pattern = "[0-9]*";
    count.maxLength = 3; // INV_MAX_STACK is 99
    count.setAttribute("aria-label", `How many to drop, up to ${max}`);
    // Tapping the box CLEARS it (maintainer): you type the number you want,
    // never "delete the 1 first". Leaving it empty is not a change — blur
    // repaints the amount that was there.
    count.addEventListener("focus", () => {
      count.value = "";
    });
    count.addEventListener("input", () => {
      const v = count.value.trim();
      if (!/^\d+$/.test(v)) return; // mid-edit junk: hold the amount
      const n = parseInt(v, 10);
      if (n >= 1 && n <= max) want = n;
    });
    count.addEventListener("blur", () => paint());
    count.addEventListener("keydown", (e) => {
      // Never let the world see these keys, and Enter commits the box.
      e.stopPropagation();
      if (e.key === "Enter") count.blur();
    });
    const of = mk("span", "ml-qty-of");
    of.textContent = `of ${max}`;
    // ONE line — count box and "of N" side by side, so the box can stand as
    // tall as the ± buttons (maintainer). The item + count group hugs the
    // LEFT edge, the two steppers sit together on the RIGHT.
    const countWrap = mk("div", "ml-qty-countwrap");
    const times = mk("span", "ml-qty-x");
    times.textContent = "×";
    countWrap.append(times, count, of);
    const steppers = mk("div", "ml-qty-steppers");
    steppers.append(dec, inc);
    head.append(img, countWrap, steppers);

    const paint = () => {
      count.value = `${want}`;
    };
    paint();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener("keydown", onKey, true);
      back.remove();
      if (this.qtyClose === close) this.qtyClose = null;
      this.actions.onUiLock?.(false);
    };
    // The one action: the WORD, no icon (maintainer) — it is the confirm.
    const dropB = mk("button", "ml-plate-btn ml-qty-btn ml-qty-drop") as HTMLButtonElement;
    dropB.type = "button";
    dropB.setAttribute("aria-label", "drop");
    const dropTxt = mk("span", "");
    dropTxt.textContent = "Drop";
    dropB.appendChild(dropTxt);
    dropB.addEventListener("click", () => {
      const n = want;
      close();
      this.actions.onDropItem?.(slot, item, cx, cy, n);
    });
    card.append(head, dropB);
    back.appendChild(card);
    // A tap OUTSIDE the card is the CANCEL (maintainer: no close button).
    // Removing the card blurs the number box with it, so the phone keyboard
    // leaves too. preventDefault on the BACKDROP's own events (never the
    // card's — that would eat the buttons' clicks on touch) is the first of
    // two layers keeping that tap out of the world: Phaser's window-level
    // listeners process events whose target is not the canvas, but skip any
    // that are defaultPrevented. The second layer is WorldScene's uiLock,
    // which also covers taps on the card itself.
    const swallow = (e: Event) => {
      if (e.target === back && e.cancelable) e.preventDefault();
    };
    back.addEventListener("touchstart", swallow, { passive: false });
    back.addEventListener("mousedown", swallow);
    back.addEventListener("pointerdown", (e) => {
      if (e.target !== back) return;
      if (e.cancelable) e.preventDefault();
      close();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(back);
    this.actions.onUiLock?.(true);
    this.qtyClose = close;
  }

  pushChat(name: string, text: string, t: Date = new Date()) {
    this.chatMsgs.push({ name, text, t });
    if (this.chatMsgs.length > CHAT_HISTORY_MAX)
      this.chatMsgs.splice(0, this.chatMsgs.length - CHAT_HISTORY_MAX);
    if (this.chatShown) this.renderChat(false);
  }

  /** Rebuild the Chat log from the history: one line per message (HH:MM time +
   * name + text), with a Settings-style divider before the FIRST message and
   * whenever the real-clock day changes (YYYY-MM-DD). `toBottom` forces a scroll
   * to the newest (on open); otherwise it only follows if already near the end,
   * so reading back through history isn't yanked away by an arriving line. */
  private renderChat(toBottom: boolean) {
    const log = this.chatLogEl;
    if (!log) return;
    // Follow the newest only when forced (on open) or already near the bottom;
    // otherwise HOLD the reader's position across the rebuild. `textContent=""`
    // snaps scrollTop to 0, so capture it first and restore it — new lines are
    // appended at the bottom, so the same offset keeps the same view in sight.
    const keep = log.scrollTop;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    log.textContent = "";
    let lastDay = "";
    for (const m of this.chatMsgs) {
      const day = fmtDay(m.t);
      if (day !== lastDay) {
        // New day (and always before the first message, since lastDay starts "")
        // → a divider that looks like the Settings section header.
        lastDay = day;
        const div = mk("div", "ml-chat-day");
        div.textContent = day;
        log.appendChild(div);
      }
      const line = mk("div", "ml-chat-line");
      const time = mk("span", "ml-chat-time");
      time.textContent = fmtTime(m.t);
      const who = mk("span", "ml-chat-who");
      who.textContent = `${m.name}: `;
      line.append(time, who, document.createTextNode(m.text));
      log.appendChild(line);
    }
    log.scrollTop = toBottom || nearBottom ? log.scrollHeight : keep;
  }
}

/** Most recent chat/system lines kept for the Chat page (maintainer: last 1000,
 * drop the oldest past that). */
const CHAT_HISTORY_MAX = 1000;
const p2 = (n: number) => String(n).padStart(2, "0");
/** Local real-clock day, e.g. "2026-07-24" — the day-divider label. */
function fmtDay(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** Local wall-clock time, e.g. "14:27" — the per-message timestamp. */
function fmtTime(d: Date): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function plateButton(label: string, onPress: () => void): HTMLButtonElement {
  const b = mk("button", "ml-plate-btn") as HTMLButtonElement;
  // label lives in a span (not a bare text node) so the pressed state can
  // shift it 1 kit-pixel down with the plate art (plate.ts press rule)
  const t = mk("span", "");
  t.textContent = label;
  b.appendChild(t);
  // audio comes from pressFx (down/up pair) — no extra click sound
  b.addEventListener("click", onPress);
  pressFx(b);
  // pressed / switch-ON states are pure CSS now (.press / .on on .ml-plate-btn)
  return b;
}

/** A Settings slider for the bird-density ratio — wiki style: a slim rounded
 * track (surface-2 well), an accent fill, and a round draggable knob. LOG
 * scale 0.1×–10× with 1× centred and a soft detent that snaps to exactly 1×.
 * `get` reads the current ratio; `set` writes it live (the ambient layer
 * persists it). Pointer-drag + resize aware. */
function birdSlider(get: () => number, set: (v: number) => void): HTMLElement {
  const MINV = 0.1;
  const MAXV = 10;
  const clampV = (v: number) => Math.max(MINV, Math.min(MAXV, v));
  const clamp01 = (p: number) => Math.max(0, Math.min(1, p));
  // p (0..1) ↔ value on a LOG axis: 0 → 0.1×, 0.5 → 1×, 1 → 10×.
  const toP = (v: number) => (Math.log10(clampV(v)) + 1) / 2;
  const toV = (p: number) => Math.pow(10, p * 2 - 1);
  const fmt = (v: number) => (v >= 9.95 ? "×10" : v < 1 ? `×${v.toFixed(2)}` : `×${v.toFixed(1)}`);

  const wrap = mk("div", "ml-amb-slider");
  const head = mk("div", "ml-amb-slider-head");
  const label = mk("span", "ml-amb-slider-label");
  label.textContent = "Bird flocks";
  const valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  const track = mk("div", "ml-slider");
  const fill = mk("div", "ml-slider-fill");
  const knob = mk("div", "ml-slider-knob");
  track.append(fill, knob);
  wrap.append(head, track);

  let curP = toP(get());
  const render = (p: number) => {
    curP = p;
    // fill's right edge lands on the knob CENTRE (the value position)
    fill.style.width = `${(p * 100).toFixed(2)}%`;
    const trackW = track.clientWidth;
    const kw = knob.offsetWidth || 22;
    knob.style.left = `${Math.round(Math.max(0, Math.min(trackW - kw, p * trackW - kw / 2)))}px`;
    valEl.textContent = fmt(toV(p));
  };
  // reposition the knob when the track's size changes (orientation, resize)
  new ResizeObserver(() => render(curP)).observe(track);

  // ---- drag (pointer-capture; knob is pointer-events:none so the track owns
  // every event, and a tap anywhere on the track jumps there) ----
  const clientToP = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? clamp01((clientX - rect.left) / rect.width) : curP;
  };
  const applyP = (p: number) => {
    if (Math.abs(p - 0.5) < 0.03) p = 0.5; // soft detent → exactly 1×
    render(p);
    set(toV(p));
  };
  let dragging = false;
  track.addEventListener("pointerdown", (e) => {
    dragging = true;
    knob.classList.add("grabbing");
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — moves still work via the track listener */
    }
    applyP(clientToP(e.clientX));
    e.preventDefault();
  });
  track.addEventListener("pointermove", (e) => {
    if (dragging) applyP(clientToP(e.clientX));
  });
  for (const ev of ["pointerup", "pointercancel"] as const)
    track.addEventListener(ev, (e) => {
      if (!dragging) return;
      dragging = false;
      knob.classList.remove("grabbing");
      try {
        track.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
    });

  render(curP);
  return wrap;
}

/** A Settings slider on a LINEAR 0-100% axis — same wiki look and the same
 * pointer-capture drag as birdSlider above, but no log axis and no detent.
 * Split out rather than generalising birdSlider: that one's log scale, its 1x
 * detent and its "×N" formatting are its whole point, and folding two axes into
 * one function would make both harder to read than the ~30 duplicated lines. */
function pctSlider(
  labelText: string,
  get: () => number,
  set: (v: number) => void,
  // A STEPPED slider is the same widget with two hooks: `snap` pulls a raw
  // 0..1 drag onto the nearest legal position, and `format` writes the readout
  // in the setting's own units. Defaults give the plain percent slider back,
  // so the Indoor light one is untouched.
  opts: { snap?: (p: number) => number; format?: (p: number) => string } = {},
): HTMLElement {
  const clamp01 = (p: number) => Math.max(0, Math.min(1, p));
  const snap = opts.snap ?? ((p: number) => p);
  const format = opts.format ?? ((p: number) => `${Math.round(p * 100)}%`);
  const wrap = mk("div", "ml-amb-slider");
  const head = mk("div", "ml-amb-slider-head");
  const label = mk("span", "ml-amb-slider-label");
  label.textContent = labelText;
  const valEl = mk("span", "ml-amb-slider-val");
  head.append(label, valEl);
  const track = mk("div", "ml-slider");
  const fill = mk("div", "ml-slider-fill");
  const knob = mk("div", "ml-slider-knob");
  track.append(fill, knob);
  wrap.append(head, track);

  let curP = snap(clamp01(get()));
  const render = (p: number) => {
    curP = p;
    fill.style.width = `${(p * 100).toFixed(2)}%`;
    const trackW = track.clientWidth;
    const kw = knob.offsetWidth || 22;
    knob.style.left = `${Math.round(Math.max(0, Math.min(trackW - kw, p * trackW - kw / 2)))}px`;
    valEl.textContent = format(p);
  };
  new ResizeObserver(() => render(curP)).observe(track);

  const clientToP = (clientX: number) => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? clamp01((clientX - rect.left) / rect.width) : curP;
  };
  const applyP = (raw: number) => {
    const p = snap(raw);
    render(p);
    set(p);
  };
  let dragging = false;
  track.addEventListener("pointerdown", (e) => {
    dragging = true;
    knob.classList.add("grabbing");
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — moves still work via the track listener */
    }
    applyP(clientToP(e.clientX));
    e.preventDefault();
  });
  track.addEventListener("pointermove", (e) => {
    if (dragging) applyP(clientToP(e.clientX));
  });
  for (const ev of ["pointerup", "pointercancel"] as const)
    track.addEventListener(ev, (e) => {
      if (!dragging) return;
      dragging = false;
      knob.classList.remove("grabbing");
      try {
        track.releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
    });

  render(curP);
  return wrap;
}

/** Momentary pressed-plate feedback via pointer events: CSS :active is
 * hover-only (mobile Chrome keeps it sticky on the last tap), so touch needs
 * its own press state — added on finger-down, gone the instant the finger
 * lifts or leaves, so it can never stick. */
function pressFx(b: HTMLElement) {
  // Tactile audio rides the SAME press state as the visual pressed plate
  // (maintainer: distinct down/up sounds for immersive touch feedback) —
  // finger down clicks, finger up (or sliding off) releases, exactly once.
  let down = false;
  b.addEventListener("pointerdown", () => {
    down = true;
    b.classList.add("press");
    gameAudio.event("ui.press");
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    b.addEventListener(ev, () => {
      if (down) gameAudio.event("ui.release");
      down = false;
      b.classList.remove("press");
    });
}

function mk(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

// Chat-input keyboard lift (see mountChatKeyboardLift).
const KB_MIN = 80; // below this: no keyboard (address-bar-sized jitter)
// Assumed keyboard height when nothing reports one. Erring HIGH is nearly free
// (the box floats a little above the keys) while erring low HIDES the box, so
// these lean generous: half the viewport, but never less than 0.9×WIDTH — a
// keyboard's height tracks the screen's WIDTH (its key rows keep their aspect),
// so a pure height fraction undershoots on tall/narrow (16:9) phones — and never
// more than 0.6×height. All three are ratios, so they hold identically under
// Chrome's "desktop site" (a uniform CSS-px rescale of the same screen).
const KB_GUESS_FRAC = 0.5;
const KB_GUESS_W_FRAC = 0.9;
const KB_GUESS_MAX_FRAC = 0.6;
let kbInit = false;
/** Detach ONLY the focused chat input and float it just above the phone keyboard,
 * gliding up as the keyboard opens, while the world + HUD stay EXACTLY put with
 * the keyboard drawn on top of them (maintainer).
 *
 * TWO INDEPENDENT HALVES — the earlier attempts each got one and broke the other:
 *
 * 1. THE GAME MUST NOT MOVE. We never set `interactive-widget` in the viewport
 *    meta: `resizes-visual` made Chrome PAN the visual viewport to reveal the
 *    focused box, dragging the whole game up ("the entire game moves up"). The
 *    default already overlays on the maintainer's phone; `overlaysContent = true`
 *    reinforces it where the API exists. Once the box is floated ABOVE the
 *    keyboard the browser has nothing to reveal, so it has no reason to pan.
 *
 * 2. THE INPUT MUST RISE — even when the browser won't say how tall the keyboard
 *    is. That was the real bug: earlier tries gated the lift on a reported height
 *    (vk.boundingRect, then env(keyboard-inset-height)) and his phone reports
 *    NEITHER — the keyboard overlays and shrinks no viewport JS can read. So we
 *    read EVERY source (VirtualKeyboard rect, env() via a hidden probe,
 *    visual-viewport shrink) and POLL rather than trust one event; and when a
 *    touch device reports nothing we ESTIMATE the height and lift anyway (a
 *    slightly-too-high box is cosmetic; a hidden box is the actual bug).
 *
 * 3. THE BOX MUST CLEAR THE FRAME. Floating it just above the keyboard dropped it
 *    into the frame's bottom-rail art (maintainer: "too low, renders under the
 *    frame"). So kbHeight() floors --ml-kb so the box lands above the rail's
 *    visible top, and the on-screen chat log is pushed up above it — see kbHeight's
 *    railFloor and the .ml-kb-up CSS.
 *
 * Mounted from the HUD (injectStyles), so it only affects in-game screens — the
 * select-screen name field keeps the browser's normal scroll-into-view. */
function mountChatKeyboardLift() {
  if (kbInit) return;
  kbInit = true;
  const root = document.documentElement;
  const vk = (
    navigator as unknown as {
      virtualKeyboard?: {
        overlaysContent: boolean;
        boundingRect: DOMRectReadOnly;
        addEventListener: (t: string, cb: () => void) => void;
      };
    }
  ).virtualKeyboard;
  // Keyboard OVERLAYS the page where supported: the browser must never resize or
  // scroll the game to reveal the focused box. (Absent → Chrome's default, which
  // already overlays here; the lift below no longer depends on this API.)
  if (vk) vk.overlaysContent = true;
  const vv = window.visualViewport;
  // Hidden probe: the only way to READ env(keyboard-inset-height) from JS.
  const probe = mk("i", "");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;left:0;bottom:0;width:0;pointer-events:none;visibility:hidden;" +
    "height:env(keyboard-inset-height,0px)";
  document.body.appendChild(probe);

  let input: HTMLElement | null = null; // the focused chat input
  let lifted = false; // currently floated above the keyboard
  let poll = 0;
  let focusedAt = 0;
  let sawReport = false; // a source has, at least once, given a real keyboard height

  // touchDevice() (module-level now — shared with the landscape layout) is
  // the gate: it floats the box on every phone, and leaves a real mouse
  // desktop (no finger keyboard) alone. Under Chrome's "Request Desktop
  // Site" it reads false — accepted (maintainer: "if that's what they want
  // they should blame themselves").

  /** Keyboard height in CSS px from whichever source actually reports one. */
  const reported = () =>
    Math.max(
      vk ? Math.round(vk.boundingRect.height) : 0,
      Math.round(probe.getBoundingClientRect().height),
      vv ? Math.round(window.innerHeight - vv.height - vv.offsetTop) : 0,
    );
  // The box floats at --ml-kb + 10; to CLEAR the frame's bottom rail it must land
  // above the rail's visible top (--hud-h up from the bottom), so --ml-kb is
  // floored at hud-h + 2 (⇒ box bottom ≥ hud-h + 12). Flooring HERE (not in CSS)
  // keeps the initial arm at the box's resting spot, so it GLIDES up from rest
  // instead of snapping to the rail (maintainer: "pressed up by the keyboard… not
  // snap"). Read live so it tracks the frame across resizes.
  const railFloor = () =>
    Math.round(parseFloat(getComputedStyle(root).getPropertyValue("--hud-h")) || 0) + 2;
  const kbHeight = () => {
    const r = reported();
    if (r >= KB_MIN) { sawReport = true; return Math.max(r, railFloor()); }
    // Nothing reported — and on the maintainer's phone nothing EVER is (the
    // keyboard overlays the page without shrinking any viewport JS can read). So
    // ESTIMATE the height from THIS device's real innerHeight/innerWidth. The
    // caller (sync) only asks once it knows a keyboard is coming (touchDevice),
    // so this never floats a mouse desktop.
    const ih = window.innerHeight;
    const est = Math.min(
      Math.round(ih * KB_GUESS_MAX_FRAC),
      Math.max(Math.round(ih * KB_GUESS_FRAC), Math.round(window.innerWidth * KB_GUESS_W_FRAC)),
    );
    return Math.max(est, railFloor());
  };
  const setKb = (px: number) => root.style.setProperty("--ml-kb", `${px}px`);
  let barEl: HTMLElement | null = null; // the HUD row the input floats out of
  const drop = () => {
    lifted = false;
    root.classList.remove("ml-kb-up");
    setKb(0);
    if (barEl) {
      barEl.style.height = "";
      barEl = null;
    }
  };
  const armLift = () => {
    if (!input) return;
    // Pin the input where it currently rests (fixed at the same spot, no jump)…
    const gap = Math.max(0, Math.round(window.innerHeight - input.getBoundingClientRect().bottom));
    setKb(Math.max(0, gap - 10));
    // …and hold its HUD row open at the height it has NOW: going position:fixed
    // takes the box out of flow, which would otherwise collapse the row and slide
    // the chat log's lines down. ONLY the input may move (maintainer). The
    // in-world box is a direct child of <body> and was never in flow — pinning
    // a height there would freeze the PAGE's height, so it is skipped.
    barEl = input.parentElement;
    if (barEl && barEl !== document.body)
      barEl.style.height = `${Math.round(barEl.getBoundingClientRect().height)}px`;
    else barEl = null;
    root.classList.add("ml-kb-up");
    lifted = true;
    // …then next frame raise it to the keyboard top so the transition rides up.
    requestAnimationFrame(() => {
      if (lifted) setKb(kbHeight());
    });
  };
  const sync = () => {
    if (!input) return;
    const r = reported();
    if (r >= KB_MIN) sawReport = true;
    // Is the keyboard up right now? A real report is authoritative. A device that
    // has NEVER reported one (the maintainer's phone: the keyboard overlays and
    // shrinks nothing) can't tell — but this handler only runs while the chat box
    // HOLDS FOCUS, and the only way to focus it is to TAP it, which on a touch
    // device always opens the keyboard. So on a touch device that has never
    // reported, ASSUME it's up and float. Once a device HAS reported (sawReport),
    // trust it BOTH ways — so a real ▼/Back close drops the box AND the estimate
    // never re-floats it (which flickered it down-then-up).
    const open = r >= KB_MIN || (!sawReport && touchDevice());
    if (open) {
      if (!lifted) armLift();
      else setKb(kbHeight()); // track the keyboard (swap an estimate for a real report)
    } else if (lifted) {
      drop();
    }
  };
  // QA probe: why the box did (or didn't) lift — the two shipped attempts failed
  // precisely because nothing could see this state from outside.
  (window as unknown as { __mlKb?: () => unknown }).__mlKb = () => ({
    hasInput: !!input, lifted, reported: reported(), kb: kbHeight(),
    touch: navigator.maxTouchPoints, touchDevice: touchDevice(),
    innerH: window.innerHeight, innerW: window.innerWidth,
    screen: [screen.width, screen.height], sawReport,
    sinceFocus: focusedAt ? Date.now() - focusedAt : null, polling: poll !== 0,
  });
  // BOTH chat boxes: the Chat page's (.ml-chat-input) and the in-world
  // overlay's (.ml-chatinput, chat.ts). Either one focused means a keyboard is
  // coming, and everything anchored to the bottom has to get out of its way.
  // The drop dialog's number box deliberately does NOT ride along: it floats
  // nothing, and lifting the card when the number keyboard opened moved the
  // dialog out from under the maintainer's finger. It clears the keys by
  // sitting at 45% of the view instead (see .ml-qty).
  const isChatInput = (t: EventTarget | null) =>
    t instanceof HTMLElement &&
    (t.classList.contains("ml-chat-input") || t.classList.contains("ml-chatinput"));
  document.addEventListener("focusin", (e) => {
    if (!isChatInput(e.target)) return;
    input = e.target as HTMLElement;
    focusedAt = Date.now();
    sync();
    // POLL: geometrychange/visualViewport don't fire on every device (that's how
    // the lift died twice) — a cheap timer while the box is focused can't miss.
    window.clearInterval(poll);
    poll = window.setInterval(sync, 100);
  });
  document.addEventListener("focusout", (e) => {
    if (!isChatInput(e.target)) return;
    input = null;
    window.clearInterval(poll);
    poll = 0;
    drop();
  });
  // Android ▼/Back hides the keyboard WITHOUT blurring the field. The user's
  // next tap OUTSIDE the box means they're done: blur it (→ focusout → drop).
  // Tapping the box itself keeps focus so you can keep typing.
  // THE GATE IS FOCUS, NOT `lifted` (maintainer 2026-08-05: "closes the
  // keyboard… now attacks an enemy or clicks the game-view and the keyboard
  // will open again"): once a device HAS reported a keyboard height, the ▼
  // close drops the float but the field keeps focus, and Chrome re-opens the
  // keyboard on the next tap because a text field is still focused — Phaser
  // preventDefault()s the canvas pointerdown, so nothing else ever takes
  // focus away. Capture phase, so it can't be swallowed on the way down.
  addEventListener("pointerdown", (e) => {
    if (input && e.target !== input) input.blur();
  }, { capture: true, passive: true });
  vk?.addEventListener("geometrychange", sync);
  vv?.addEventListener("resize", sync);
  vv?.addEventListener("scroll", sync);
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  mountTheme(); // shared wiki tokens + dark-mode sync — everything below uses them
  mountChatKeyboardLift();
  const css = `
  /* ── shell: golden-ratio split, a plain 1px border where the frame was ── */
  .ml-hud{position:fixed;left:0;right:0;top:var(--hud-h-inv,61.8dvh);bottom:0;z-index:4;
    background:var(--bg);color:var(--ink);border-top:1px solid var(--border);
    font:14px/1.45 var(--sans);display:flex;flex-direction:column;box-sizing:border-box}
  .ml-hud *{box-sizing:border-box}
  /* ── tab row: six icon buttons on the wiki button recipe. 16px side margins
     match the pages (maintainer 2026-07-30: "more left and right margin"), and
     a 1px bottom rule closes the bar like every other themed surface — the
     page scrolls UNDER it, so without the line the clipped content read as a
     broken edge (maintainer 2026-07-30, green mark). ── */
  .ml-tabrow{flex:none;display:flex;gap:6px;padding:10px 16px 10px;
    border-bottom:1px solid var(--border)}
  .ml-tab{flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;
    height:56px;padding:0;cursor:pointer;overflow:hidden;
    background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:12px;
    touch-action:manipulation;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
  .ml-tab:hover{background:var(--surface-2)}
  .ml-tab.press{transform:translateY(1px);background:var(--surface-2);border-color:var(--border-strong)}
  .ml-tab.sel{background:var(--accent-soft);border-color:var(--accent)}
  /* icons keep the pixel art (maintainer: "not the icons") at the AUTHORED 1x
     grid — JS sizes each img to naturalWidth/2 (the bakes are exact 2x of the
     hand-drawn art; a fixed square box distorted + fractionally scaled them) */
  .ml-tab-icon{image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  /* rotation = SNAP (beginFlip holds ml-noanim through the whole flip):
     Chrome/the OS already animate the rotation itself, so any chrome
     animation on top reads as a broken double animation (maintainer round
     5). Every anchor jumps straight to its final value; only the veil
     fades. Handedness changes keep the plain anchor transitions — nothing
     else moves during a hand switch. !important — these transitions live
     in four different injected sheets. */
  :root.ml-noanim .ml-bars,:root.ml-noanim .ml-clock,:root.ml-noanim .ml-wikibtn,:root.ml-noanim .ml-wikinear,
  :root.ml-noanim .ml-chatlog,:root.ml-noanim .ml-chatinput{transition:none!important}
  /* the rotation veil: theme surface over the game view while the canvas
     re-fits (beginFlip). Fades on the compositor once the world is ready. */
  .ml-flip-veil{position:fixed;inset:0;z-index:3;background:var(--bg);
    pointer-events:none;opacity:1;transition:opacity .35s ease}
  /* Rotation exposes raw page behind the canvas for a few frames while the
     browser restages the viewport (maintainer screenshots 2026-08-05:
     "buggy black"). index.html paints #000 for the pre-game screens; in the
     world, the exposed area wears the theme background instead, so a
     mid-rotation frame reads as chrome-on-surface, not a black hole. */
  html.ml-ingame, html.ml-ingame body{background:var(--bg)}
  /* ── LANDSCAPE (maintainer 2026-08-05): the same 61.8/38.2 split turned on
     its side — the menu becomes a full-height SIDE COLUMN (--menu-w, set by
     applyLayout) and the tab row a VERTICAL strip. "Buttons always closest
     to the game-view": right-handed (default) puts the menu on the LEFT with
     the tabs on its right edge; left-handed (.ml-lh) mirrors the whole
     column. The icons stay upright — the strip re-flows, the art never
     rotates (a sideways backpack is not a backpack). In-game + touch only:
     applyLayout sets .ml-land, so desktop keeps the portrait split. ── */
  :root.ml-land .ml-hud{top:0;bottom:0;left:0;right:auto;width:var(--menu-w,38.2vw);
    flex-direction:row;border-top:none;border-right:1px solid var(--border)}
  :root.ml-land.ml-lh .ml-hud{left:auto;right:0;
    border-right:none;border-left:1px solid var(--border)}
  :root.ml-land .ml-tabrow{flex-direction:column;flex:none;width:84px;height:auto;
    padding:12px 8px;gap:6px;order:2;justify-content:center;
    border-bottom:none;border-left:1px solid var(--border)}
  :root.ml-land.ml-lh .ml-tabrow{order:0;border-left:none;border-right:1px solid var(--border)}
  /* full-size buttons (maintainer 2026-08-05: "the menu buttons … look
     smaller in landscape"): the global ≤640px-HEIGHT rule was written for
     SHORT PORTRAIT phones, but every landscape phone is ≤640px tall, so it
     silently shrank the strip to 48px. Landscape keeps the 56px buttons —
     6×56 + gaps + padding = 390px, which fits any ≥393px-tall viewport —
     and only genuinely tiny phones drop back to 48. */
  :root.ml-land .ml-tab{flex:0 0 auto;width:100%;height:56px}
  @media (max-height:388px){ :root.ml-land .ml-tab{height:48px} }
  :root.ml-land .ml-pages{order:1;min-width:0}
  /* the settings grid drops to two columns in the narrow landscape column —
     three squeezed the labels into clipped fragments ("weathe…") */
  :root.ml-land .ml-btnrow{grid-template-columns:repeat(2,1fr)}
  /* the backpack turns its grid on its side with the layout (maintainer
     2026-08-05: rows & cols switch — 3 wide × 5 tall): five 1fr columns in
     the narrow menu column made ~33px slots; three make them page-filling.
     The width cap is HEIGHT-derived so all 5 rows always fit WITHOUT the
     ugly 1px scroll (same maintainer, next round): slot = (100dvh − 72px)/5
     — 72 = the page's 26px padding + 4×10px gaps + slack — and grid width =
     3 slots + 2 gaps. The 320px cap keeps tablet columns from ballooning. */
  :root.ml-land .ml-slots{grid-template-columns:repeat(3,1fr);
    max-width:min(320px, calc((100dvh - 72px)*0.6 + 20px))}
  /* ── pages ── */
  .ml-pages{flex:1 1 auto;min-height:0;position:relative}
  /* 'safe center' keeps a short page centred but falls back to top-anchored the
     instant the content is taller than the page; overflow-y then scrolls it
     (maintainer: "always see the top UI on that page before we scroll"). */
  .ml-page{display:none;height:100%;overflow-y:auto;overflow-x:hidden;
    -webkit-overflow-scrolling:touch;flex-direction:column;align-items:center;
    justify-content:safe center;gap:12px;text-align:center;
    padding:10px 16px 16px;background:var(--bg)}
  .ml-page.show{display:flex}
  /* gamepad page: the analog stick + jump button position absolutely inside it */
  .ml-page[data-page=gamepad]{position:relative;overflow:hidden}
  /* map page: the world's iso minimap centred with a live "you are here" dot.
     .ml-map-frame is JS-sized to the fitted image (fitMap) so the dot's percent
     offsets land on the right pixel. Pixel-art: nearest-neighbour. */
  .ml-page[data-page=map]{overflow:hidden}
  .ml-map{flex:1 1 auto;min-height:0;width:100%;display:flex;
    align-items:center;justify-content:center;overflow:hidden}
  .ml-map-frame{position:relative;line-height:0;flex:none}
  .ml-map-frame[hidden]{display:none}
  .ml-map-img{display:block;width:100%;height:100%;image-rendering:pixelated;
    -webkit-user-drag:none;pointer-events:none}
  .ml-map-dot{position:absolute;left:50%;top:50%;width:12px;height:12px;
    transform:translate(-50%,-50%);border-radius:50%;background:var(--accent);
    border:2px solid #fff;box-sizing:border-box;pointer-events:none;
    box-shadow:0 0 0 1px rgba(0,0,0,.3);z-index:1}
  .ml-map-empty{color:var(--muted);font:600 14px var(--sans);
    text-align:center;padding:24px;line-height:1.5}
  .ml-map-empty[hidden]{display:none}
  /* ── backpack slots: wiki empty cells ── */
  .ml-slots{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;
    width:100%;max-width:560px;margin:auto 0}
  .ml-slot.filled{position:relative;cursor:grab;touch-action:none}
  .ml-slot.filled img{width:80%;height:80%;object-fit:contain;image-rendering:pixelated;
    position:absolute;left:10%;top:10%;pointer-events:none}
  /* the ×N count, lower-right of EVERY filled slot (maintainer 2026-08-05).
     A small chip rather than bare text: it sits over the sprite's corner on a
     crowded icon, and the ×1 case must stay quiet. */
  .ml-slot.filled b{position:absolute;right:3px;bottom:2px;pointer-events:none;
    padding:0 3px;border-radius:6px;font:700 11px/1.5 var(--sans);color:var(--ink);
    background:color-mix(in srgb, var(--surface) 82%, transparent)}
  .ml-slot.dragging{opacity:.45}
  .ml-slot-ghost{position:fixed;width:40px;height:40px;z-index:60;pointer-events:none;
    image-rendering:pixelated;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))}
  /* ── drop-quantity dialog: centred in the GAME VIEW, over a backdrop that
     eats every pointer (that IS the movement lock's first half; the second is
     onUiLock → Phaser's keyboard). The gv insets + --hud-h centre it inside
     the view in BOTH orientations: portrait subtracts the HUD rail at the
     bottom, landscape the menu column at one side. z 70 clears every other
     overlay (slot ghost 60, floated chat input 50, chips 8). ── */
  /* The backdrop DARKENS in BOTH themes (maintainer 2026-08-05) — a
     theme-coloured wash brightened the world in light mode, which read as the
     dialog lighting the room instead of dimming it. */
  .ml-qty-back{position:fixed;inset:0;z-index:70;
    background:rgba(0,0,0,.5);
    backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
  /* The card sits at 45% of the GAME VIEW's height, not 50% (maintainer
     2026-08-05): a hair above centre, which keeps the number box clear of
     the phone's number keyboard WITHOUT the card jumping when it opens —
     a lift that moves the dialog under your finger is worse than the few
     px it saves. Horizontally it is centred between the gv insets.
     LANDSCAPE takes 40%: the view is ~393px tall there and the keyboard
     eats a bigger share of it, so the card needs the extra step up. */
  .ml-qty{position:absolute;
    left:calc(var(--gv-left,0px) + (100vw - var(--gv-left,0px) - var(--gv-right,0px)) / 2);
    top:calc((100dvh - var(--hud-h,0px)) * .45);
    transform:translate(-50%,-50%);
    width:min(320px, calc(100vw - var(--gv-left,0px) - var(--gv-right,0px) - 40px));
    box-sizing:border-box;display:flex;flex-direction:column;gap:10px;
    background:var(--bg);border:1px solid var(--border);border-radius:14px;
    padding:14px;box-shadow:var(--shadow)}
  :root.ml-land .ml-qty{top:calc((100dvh - var(--hud-h,0px)) * .4)}
  /* ONE row: item + count LEFT, the two steppers together RIGHT (maintainer:
     "the + and minus buttons should be left aligned on the right side. The
     ×1 of 5 input should be left aligned on the left side") */
  .ml-qty-head{display:flex;align-items:center;gap:8px}
  .ml-qty-steppers{margin-left:auto;display:flex;align-items:center;gap:8px}
  .ml-qty-head img{width:44px;height:44px;flex:none;object-fit:contain;
    image-rendering:pixelated}
  .ml-qty-countwrap{flex:0 1 auto;min-width:0;display:flex;align-items:center;
    justify-content:flex-start;gap:5px}
  .ml-qty-x{font:700 20px/1.15 var(--sans);color:var(--muted)}
  .ml-qty-count{width:2.6em;height:44px;box-sizing:border-box;text-align:center;
    background:var(--surface);color:var(--ink);
    border:1px solid var(--border);border-radius:10px;padding:0 4px;
    font:700 22px/1.2 var(--sans);font-variant-numeric:tabular-nums;outline:none}
  .ml-qty-count:focus{border-color:var(--accent)}
  .ml-qty-of{font:500 13px/1.3 var(--sans);color:var(--muted);white-space:nowrap}
  .ml-qty-btn{padding:8px;flex:none}
  .ml-qty-dec,.ml-qty-inc{width:44px}
  .ml-qty-btn svg{width:20px;height:20px;fill:none;stroke:currentColor;
    stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  /* the only action button: full width, and it SAYS what it does (maintainer).
     .ml-plate-btn's own background rule is later in this sheet, so the accent
     needs the extra class to win. */
  .ml-plate-btn.ml-qty-drop{width:100%;background:var(--accent-soft);
    border-color:var(--accent);font-weight:700;letter-spacing:.08em;
    text-transform:uppercase}
  .ml-plate-btn:disabled{opacity:.4;cursor:default}
  .ml-slot{display:block;aspect-ratio:1;background:var(--surface-2);
    border:1px solid var(--border);border-radius:10px}
  /* ── buttons: .ml-plate-btn survives as a CLASS (the ambient agent injects
     one from outside) but is the wiki button recipe now ── */
  .ml-plate-btn{display:flex;align-items:center;justify-content:center;gap:8px;
    min-height:44px;padding:8px 12px;cursor:pointer;
    background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:10px;
    font:600 13px/1.25 var(--sans);
    touch-action:manipulation;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;
    user-select:none;-webkit-user-select:none}
  .ml-plate-btn:hover{background:var(--surface-2)}
  .ml-plate-btn.press{transform:translateY(1px);background:var(--surface-2);border-color:var(--border-strong)}
  .ml-plate-btn.on,.ml-plate-btn.sel{background:var(--accent-soft);border-color:var(--accent);font-weight:700}
  /* ── settings ── */
  .ml-set{display:flex;flex-direction:column;align-items:stretch;gap:14px;
    width:100%;max-width:560px}
  .ml-btnrow{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  /* the wide Log out button at the top of Settings: a full row of the column */
  .ml-page>.ml-plate-btn{width:100%;max-width:560px;flex:none}
  /* ── ambient-effect checklist ── */
  .ml-amb{display:flex;flex-direction:column;gap:8px;width:100%}
  .ml-amb-title{border-top:1px solid var(--border);padding-top:12px;
    color:var(--muted);font:600 12px/1.2 var(--sans);letter-spacing:.08em;
    text-transform:uppercase;text-align:center}
  .ml-amb-list{display:flex;flex-direction:column;gap:8px;width:100%}
  .ml-amb-row{justify-content:flex-start;gap:12px;text-align:left;white-space:nowrap}
  .ml-amb-row.blocked{opacity:.5}
  .ml-amb-label{overflow:hidden;text-overflow:ellipsis}
  /* pure-CSS checkbox: accent fill + white tick when .on */
  .ml-amb-check{width:18px;height:18px;flex:none;position:relative;
    background:var(--surface);border:1px solid var(--border-strong);border-radius:5px}
  .ml-amb-check.on{background:var(--accent);border-color:var(--accent)}
  .ml-amb-check.on::after{content:"";position:absolute;left:5px;top:1px;width:5px;height:10px;
    border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
  /* ── bird-density slider ── */
  .ml-amb-slider{display:flex;flex-direction:column;gap:6px;width:100%;padding:0 2px 6px}
  .ml-amb-slider-head{display:flex;justify-content:space-between;align-items:baseline;
    font:600 13px/1.2 var(--sans);color:var(--ink)}
  .ml-amb-slider-val{color:var(--muted);font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12px}
  .ml-slider{position:relative;height:26px;touch-action:none;cursor:pointer}
  .ml-slider::before{content:"";position:absolute;left:0;right:0;top:50%;height:8px;
    transform:translateY(-50%);background:var(--surface-2);
    border:1px solid var(--border);border-radius:999px}
  .ml-slider-fill{position:absolute;left:0;top:50%;height:8px;transform:translateY(-50%);
    background:var(--accent);border-radius:999px;pointer-events:none}
  .ml-slider-knob{position:absolute;top:50%;width:22px;height:22px;margin-top:-11px;
    border-radius:50%;background:var(--surface);border:1px solid var(--border-strong);
    box-shadow:var(--shadow);pointer-events:none}
  .ml-slider-knob.grabbing{background:var(--accent-soft);border-color:var(--accent)}
  /* ── chat page: log panel + input ── */
  .ml-chat{flex:1 1 auto;min-height:0;width:100%;max-width:640px;
    display:flex;flex-direction:column;gap:10px}
  .ml-chat-log{flex:1 1 auto;min-height:0;width:100%;overflow-y:auto;overflow-x:hidden;
    display:flex;flex-direction:column;gap:4px;text-align:left;
    font:13.5px/1.45 var(--sans);color:var(--ink);
    background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px 12px}
  .ml-chat-day{border-top:1px solid var(--border);padding-top:10px;margin-top:4px;
    color:var(--muted);font:600 11px/1.2 var(--sans);letter-spacing:.08em;
    text-transform:uppercase;text-align:center;text-shadow:none}
  .ml-chat-day:first-child{border-top:none;margin-top:0;padding-top:0}
  .ml-chat-line{overflow-wrap:anywhere}
  .ml-chat-time{color:var(--muted);margin-right:7px;font-variant-numeric:tabular-nums;
    font-family:var(--mono);font-size:.85em}
  .ml-chat-who{color:var(--accent-ink);font-weight:600}
  /* lifted a step off the page bottom (maintainer 2026-07-30: the input sat
     on the very edge, over the old badge spot) */
  .ml-chat-inputbar{flex:none;width:100%;margin-bottom:12px}
  .ml-chat-input{width:100%;background:var(--surface);color:var(--ink);
    border:1px solid var(--border);border-radius:10px;padding:10px 12px;
    font:14px/1.3 var(--sans);outline:none}
  .ml-chat-input:focus{border-color:var(--accent)}
  .ml-chat-input::placeholder{color:var(--muted)}
  /* The prompt is an invitation, not a label: once the keyboard is up and you
     are actually typing it just gets in the way, so it goes (maintainer). */
  .ml-chat-input:focus::placeholder{color:transparent}
  /* Phone keyboard: the world + HUD stay put (virtualKeyboard.overlaysContent —
     the keyboard is drawn on top, the browser doesn't scroll/reflow the game).
     While a chat input is focused and the keyboard is up (.ml-kb-up, driven by
     mountChatKeyboardLift), float ONLY that input up so you can SEE what you
     type (maintainer). --ml-kb is floored in kbHeight() so the box always
     clears the HUD's top edge; the on-screen chat log is pushed up above it.
     Never fires on desktop (no keyboard → --ml-kb stays 0, the class never
     sets). */
  :root{--ml-inputlift:calc(var(--ml-kb,0px) + 10px)}
  /* The floated box lives INSIDE the game view (maintainer 2026-08-05: "not
     stretch all the way from side to side") — the gv insets are 0 in
     portrait, so there this is the same full-width-minus-10px it always was;
     in landscape they subtract the menu column. */
  .ml-kb-up .ml-chat-input:focus{position:fixed;z-index:50;width:auto;
    left:calc(var(--gv-left,0px) + 10px);right:calc(var(--gv-right,0px) + 10px);
    bottom:var(--ml-inputlift);
    box-shadow:var(--shadow);transition:bottom .15s ease-out}
  /* The floated box takes the full width just above the keys, so EVERYTHING
     else that lives on the bottom edge steps up over it: the on-screen chat
     log (chat.ts) on the left and the time-of-day pill on the right. Both
     land on the same line — the log's max-width already reserves the pill's
     lane. :root outranks their own bottom rules whatever order the
     stylesheets were injected in. */
  :root.ml-kb-up .ml-chatlog,
  :root.ml-kb-up .ml-clock{bottom:calc(var(--ml-inputlift) + 56px)}
  /* ── compact fits (icons stay at their authored 1x grid at every size) ── */
  @media (max-width:480px){
    .ml-btnrow{gap:6px}
    .ml-plate-btn{padding:6px 8px;font-size:12px}
  }
  @media (max-height:640px){
    .ml-tabrow{padding:8px 14px 8px}
    .ml-tab{height:48px}
    .ml-page{gap:8px;padding:8px 14px 12px}
    .ml-plate-btn{min-height:36px}
    .ml-set{gap:10px}
    .ml-amb-list{gap:6px}
    .ml-slots{gap:8px}
    .ml-chat-log{font-size:12.5px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

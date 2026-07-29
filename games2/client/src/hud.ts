/**
 * Bottom HUD + the page frame — built EXACTLY like the maintainer's mock:
 * ONE continuous frame around the whole page, with two horizontal DIVIDER
 * assemblies splitting it into game viewport / tab row / content page.
 *
 * Frame rules learned from round 1 (maintainer feedback):
 * - NOTHING is mirrored. The art's lighting differs per side — every corner,
 *   rail direction and gem is its own tile (scripts/build-ui-tiles.mjs).
 * - The dividers are real ╠/╣ T-intersections joining the outer rails, each
 *   with its own rail lighting (divider A ≠ divider B ≠ outer rails); no
 *   stacked "double borders" between sections.
 * - Corners include the transition stretch into the clean repeating rail.
 * - Tiles render at CONCEPT scale 1:1 CSS px ("2× bigger"), nearest-neighbour
 *   (image-rendering: pixelated) to keep the chunky pixel-art look.
 *
 * Piece alignment: every crop starts 20px before its rail band, so the gold
 * band sits 6..30px from the crop edge — anchoring all pieces flush to the
 * page edges lines the bands up seam-free. Divider tiles carry their own
 * vertical offsets (see the *-y constants baked into the CSS).
 *
 * The overlay ignores the pointer entirely; the interactive tab row/pages
 * live in .ml-hud underneath it. Nothing here is uiZoom'd (the dvh geometry
 * must match the #game split; CSS zoom rescales viewport units).
 */

import { mountFrame2, FrameLayout, HUD_SCALE } from "./frame2";
import { setClockMount } from "./clock";
import { dressPlate, dressSlot, hudKitPx, nineSlice, readyPlates, repaintPlates } from "./plate";
import { holdLoading } from "./loading";
import { mountGamepadStick } from "./gamepad";
import { mountBars } from "./bars";
import { gameAudio } from "../../composer/index";
import { MAX_CHAT_LEN } from "@nangijala/shared";

// ── Ambient-effect switches (Settings) ───────────────────────────────────
// The ambient-life agent (ambient/) exposes a per-effect TOGGLE controller on
// window.__mlAmbient: several COMPATIBLE effects can run at once, but an effect
// can't switch on while an incompatible one is active (each declares its
// `conflicts`). We render a checkbox list from it — data-driven, so a conflict
// the ambient agent adds/drops updates the UI with no code change here. See
// ambient/README.md "Toggling effects independently".
const CHECK_ON = "/ui2/kit-check-on.png";
const CHECK_OFF = "/ui2/kit-check-off.png";
// Bird-density slider art: the SAME UI-kit bar the HP/EP/XP gauges use (bars.ts)
// — its frame is the track, a fill shows the filled portion, and a kit plate is
// the draggable knob (maintainer 2026-07-25: "This slider should use UI-kit to
// extract its graphics").
const BAR_FRAME = "/ui2/bar-frame.png";
const BAR_FILL = "/ui2/bar-fill-yellow.png";
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
// Set a checkbox img to on/off, skipping the write when unchanged (the 700ms
// poll re-runs constantly while Settings is open — don't re-touch src needlessly).
function setCheck(img: HTMLImageElement, on: boolean) {
  const src = on ? CHECK_ON : CHECK_OFF;
  if (!img.src.endsWith(src)) img.src = src;
}
// One shared refresh poll for the live ambient state (the director rolls
// episodes + fields gate on time-of-day, so the switches must track a moving
// target while Settings is open). Module-level so a HUD rebuild on re-join
// replaces it instead of leaking a second timer.
let ambPoll: ReturnType<typeof setInterval> | null = null;

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

/** Mount the composed frame-v2 canvas (see frame2.ts) and keep the HUD
 * sections + the #game split glued to the frame's window rectangles. The
 * old tile-assembly overlay is gone — the frame is now one runtime-composed
 * canvas that stretches its plain sections to any viewport. */
export function mountPageFrame() {
  injectStyles();
  mountBars(); // HP/MP gauges, top-left of the game view
  document.getElementById("ml-pageframe")?.remove(); // old overlay, if any
  // first-render gates for the loading fade: the black must not lift until
  // the frame has actually composed (its art comes over the network on a
  // fresh deploy) and the kit plate art is in (tabs/buttons/slots)
  let composed: (() => void) | null = null;
  holdLoading(new Promise<void>((r) => (composed = r)));
  holdLoading(readyPlates());
  mountFrame2((l) => {
    lastLayout = l;
    composed?.();
    composed = null;
    applyFrameLayout();
  });
}

let lastLayout: FrameLayout | null = null;

/** Position the HUD sections into the frame's windows (called after every
 * frame compose AND after HudBar [re]construction). The game/HUD boundary
 * vars keep chat + the Phaser canvas split in sync, exactly like before. */
function applyFrameLayout() {
  const l = lastLayout;
  if (!l) return;
  // the animated clock hand hangs its ring on the frame's strap stub
  setClockMount(l.clockAnchor.x, l.clockAnchor.y, l.scale);
  const root = document.documentElement;
  // the game canvas runs to gameHeight (inside rail A's opaque band, so the
  // frame art overlays the world), but chat keeps anchoring above the rail's
  // VISIBLE top edge — anchored to gameHeight it would slide under the rail
  root.style.setProperty("--hud-h-inv", `${Math.round(l.gameHeight)}px`);
  root.style.setProperty("--hud-h", `${Math.round(window.innerHeight - l.railTop)}px`);
  // the frame's render scale — frame-space art (backpack slots) rides it so
  // 1 art px always equals 1 frame px on screen, whatever the viewport
  root.style.setProperty("--ml-fs", String(l.scale));
  const hud = document.querySelector<HTMLElement>(".ml-hud");
  if (!hud) return;
  hud.style.top = `${Math.round(l.gameHeight)}px`;
  hud.style.height = "auto";
  hud.style.bottom = "0";
  const tr = hud.querySelector<HTMLElement>(".ml-tabrow");
  const pg = hud.querySelector<HTMLElement>(".ml-pages");
  const place = (el: HTMLElement | null, r: { left: number; top: number; width: number; height: number }) => {
    if (!el) return;
    el.style.left = `${Math.round(r.left)}px`;
    el.style.top = `${Math.round(r.top - l.gameHeight)}px`;
    el.style.width = `${Math.round(r.width)}px`;
    el.style.height = `${Math.round(r.height)}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  };
  place(tr, l.tabRect);
  // pages span the FULL viewport width (maintainer: the stone backdrop
  // "should span from the very left to the very right"); the frame canvas
  // overlays the rails on top, and content insets to the inner window via
  // --ml-page-pad. Height runs to the viewport bottom — the bottom rail art
  // covers the tail.
  if (pg) {
    // the stone starts at rail B's TOP edge (under the opaque rail art) so
    // no dark strip can open between the rail and the backdrop; content
    // stays below the rail via --ml-page-padtop
    pg.style.left = "0";
    pg.style.top = `${Math.round(l.pageTuckTop - l.gameHeight)}px`;
    pg.style.width = "100vw";
    pg.style.height = `${Math.round(window.innerHeight - l.pageTuckTop)}px`;
    pg.style.right = "auto";
    pg.style.bottom = "auto";
  }
  // content box == the frame's true inner window on ALL FOUR sides — the
  // grids distribute space-evenly inside it, so the margin against the frame
  // equals the gap between items (maintainer: "the spacing should look even")
  document.documentElement.style.setProperty("--ml-page-pad", `${Math.round(l.pageRect.left)}px`);
  document.documentElement.style.setProperty(
    "--ml-page-padtop", `${Math.round(l.pageRect.top - l.pageTuckTop)}px`);
  document.documentElement.style.setProperty(
    "--ml-page-padbot", `${Math.round(window.innerHeight - (l.pageRect.top + l.pageRect.height))}px`);
}

/** The live feed the Map tab reads from window.__ml.minimap() (WorldScene). */
interface MinimapFeed {
  world: string; // maps2 world id (folder name) -> /assets/maps2/worlds/<id>/minimap.png
  w: number; // grid width in cells
  h: number; // grid height in cells
  maxL: number; // world's tallest terrain level (the iso render's origin lifts by this)
  col: number; // local player's fractional cell (fx / CELL_WU)
  row: number; // local player's fractional cell (fy / CELL_WU)
  level: number; // terrain level at the player's cell (the iso dot lifts with it)
}

// maps2 ISOMETRIC minimap projection — a REPLICA of maps2/pipeline/render2.py
// (render_overview / _origin), so the "you are here" dot lands on the player's
// cell on the iso minimap.png. The minimaps are transparent iso renders (not
// top-down), verified to share this transform across every world incl.
// the_island2's custom builder. DX/DY/LEVEL_PX match shared ISO_DX/ISO_DY/
// LEVEL_PX; MARGIN + the 40/64/80 canvas pads are render2.py's. Percentages are
// scale-invariant, so the 0.5 render scale + 2000px save cap drop out.
const MM_DX = 32, MM_DY = 15, MM_LEVEL_PX = 16, MM_MARGIN = 12;
/** Player cell (col,row) at terrain `level` -> [x%, y%] on the iso minimap. */
function minimapDotPct(m: MinimapFeed): [number, number] {
  const ox = (m.h - 1) * MM_DX + MM_MARGIN;
  const oy = m.maxL * MM_LEVEL_PX + 40 + MM_MARGIN;
  const fullW = (m.w + m.h) * MM_DX + MM_MARGIN * 2;
  const fullH = (m.w + m.h) * MM_DY + 64 + m.maxL * MM_LEVEL_PX + 80;
  // +MM_DX/+MM_DY: centre of the cell's 64-wide, 30-tall top diamond.
  const x = ox + (m.col - m.row) * MM_DX + MM_DX;
  const y = oy + (m.col + m.row) * MM_DY - m.level * MM_LEVEL_PX + MM_DY;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return [clamp(x / fullW) * 100, clamp(y / fullH) * 100];
}

export class HudBar {
  private pages = new Map<TabId, HTMLElement>();
  private tabs = new Map<TabId, HTMLButtonElement>();
  private switches: [HTMLButtonElement, () => boolean][] = [];
  private stateful: [HTMLButtonElement, HudActions["settings"][number]][] = [];
  // ambient-effect checklist (populated once window.__mlAmbient is up)
  private ambSection: HTMLElement | null = null;
  private ambList: HTMLElement | null = null;
  private ambRows = new Map<string, { el: HTMLButtonElement; img: HTMLImageElement; label: HTMLElement }>();
  private ambAuto: { el: HTMLButtonElement; img: HTMLImageElement } | null = null;
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
    const hud = mk("div", "ml-hud");
    const tabRow = mk("div", "ml-tabrow");
    const pageWrap = mk("div", "ml-pages");

    for (const t of TABS) {
      const b = mk("button", "ml-tab") as HTMLButtonElement;
      b.dataset.tab = t.id;
      // icon only — no text label (maintainer 2026-07-18: "icon is enough");
      // the label lives on as the accessible name
      const icon = mk("img", "ml-tab-icon") as HTMLImageElement;
      icon.src = `/ui2/icon-${t.id}.png`;
      icon.alt = "";
      icon.draggable = false;
      b.title = t.label;
      b.setAttribute("aria-label", t.label);
      b.append(icon);
      // audio comes from pressFx (down/up pair) — no extra click sound
      b.addEventListener("click", () => this.select(t.id));
      pressFx(b);
      dressPlate(b, kindForState, true); // the kit trio, frame-scaled blocks
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
    applyFrameLayout(); // adopt the frame windows if the frame is already composed

    // Keep the ambient switches tracking live state while Settings is open
    // (director rolls, fields gate on time-of-day). Replaces any prior timer
    // so a HUD rebuild on re-join never leaves two running.
    if (ambPoll) clearInterval(ambPoll);
    ambPoll = setInterval(() => this.tickAmbient(), 700);
  }

  private select(id: TabId) {
    for (const [tid, b] of this.tabs) b.classList.toggle("sel", tid === id);
    let shown: HTMLElement | undefined;
    for (const [tid, p] of this.pages) {
      const on = tid === id;
      p.classList.toggle("show", on);
      if (on) shown = p;
    }
    // Plates built while the page was display:none measured 0×0 — repaint
    // them now that the page has a real size (next frame, after layout).
    if (shown) requestAnimationFrame(() => repaintPlates(shown!));
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
  /** Build the Map page: a fitted minimap <img> plus a red "you are here" dot
   * positioned by PERCENT via the iso projection (so it stays correct at any
   * display size), over a fallback message for worlds that ship no minimap.png.
   * The dot + image are driven by startMapLoop(). */
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
    let w = box.width, h = w / ar;
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
    // Load the world's minimap once (and again if the world changed on rejoin).
    if (m.world && m.world !== this.mapSrcWorld) {
      this.mapSrcWorld = m.world;
      els.frame.hidden = false;
      els.empty.hidden = true;
      els.img.src = `/assets/maps2/worlds/${m.world}/minimap.png`;
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
    requestAnimationFrame(() => repaintPlates(list));
  }

  /** A checkbox row (kit plate bar + checkbox img + label). name=null → the
   * AUTO row. Returns its element refs for state updates. */
  private ambRow(name: string | null, label: string) {
    const b = mk("button", "ml-plate-btn ml-amb-row") as HTMLButtonElement;
    if (name === null) b.classList.add("ml-amb-auto");
    const img = mk("img", "ml-amb-check") as HTMLImageElement;
    img.src = CHECK_OFF;
    img.alt = "";
    img.draggable = false;
    const t = mk("span", "ml-amb-label");
    t.textContent = label;
    b.append(img, t);
    b.addEventListener("click", () => this.onAmbient(name));
    pressFx(b);
    dressPlate(b, kindForState, true);
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

    // Backpack: 5×3 empty item slots — the REAL slot art from the round-2
    // concept (twig frame + moss rim over a dark recess, extracted at native
    // 128² in frame space; scripts/extract-slot2.py). Same count and layout
    // as the concept page. Real inventory comes later.
    const bp = this.pages.get("backpack")!;
    const slots = mk("div", "ml-slots");
    for (let i = 0; i < 15; i++) {
      const sl = mk("i", "ml-slot");
      dressSlot(sl); // the kit's empty-slot square, integer-scaled + centred
      slots.appendChild(sl);
    }
    bp.append(slots);

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
    this.refreshSettings();
    wrap.appendChild(row);
    // Restore the .ml-plate-btn class CONTRACT for foreign buttons: the
    // ambient agent injects its cycler into this row from outside
    // (ambient/runtime/hudbutton.ts) relying on the class to bring the plate
    // art — which stopped being CSS when plates went runtime-composed. Dress
    // any undressed arrival so injected buttons look like every other row.
    new MutationObserver(() => {
      row.querySelectorAll<HTMLElement>(".ml-plate-btn:not([data-plate])").forEach((el) => {
        // foreign labels arrive as bare text — wrap so the press-dip applies
        // (harmless if the owner later resets textContent: plate art stays)
        if (!el.firstElementChild && el.textContent) {
          const t = mk("span", "");
          t.textContent = el.textContent;
          el.textContent = "";
          el.appendChild(t);
        }
        dressPlate(el, kindForState, true);
      });
    }).observe(row, { childList: true });

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
  // the kit's circled state trio (plate.ts): held = the dark DOWN bar,
  // switch ON = the cream SELECTED bar, else the brown NORMAL bar
  dressPlate(b, kindForState);
  return b;
}

function kindForState(el: HTMLElement): "normal" | "sel" | "down" {
  if (el.classList.contains("press")) return "down";
  if (el.classList.contains("on") || el.classList.contains("sel")) return "sel";
  return "normal";
}

/** A Settings slider for the bird-density ratio, built from the UI-kit bar art:
 * the bar FRAME is the track, a clipped FILL shows the level, and a kit PLATE is
 * the draggable knob. LOG scale 0.1×–10× with 1× centred and a soft detent that
 * snaps to exactly 1×. `get` reads the current ratio; `set` writes it live (the
 * ambient layer persists it). Pointer-drag + resize aware. The frame/fill are
 * 9-sliced to the box like the HP/EP/XP gauges (bars.ts) so their pixels match
 * the buttons; the knob is dressed by plate.ts. */
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
  const frame = mk("img", "ml-slider-frame") as HTMLImageElement;
  const fill = mk("img", "ml-slider-fill") as HTMLImageElement;
  frame.alt = fill.alt = "";
  frame.draggable = fill.draggable = false;
  const knob = mk("div", "ml-slider-knob");
  track.append(frame, fill, knob);
  wrap.append(head, track);
  // the cream "selected" plate normally; the pressed DOWN plate while grabbing
  dressPlate(knob, () => (knob.classList.contains("grabbing") ? "down" : "sel"), true);

  let curP = toP(get());
  const render = (p: number) => {
    curP = p;
    // fill's right edge lands on the knob CENTRE (the value position)
    fill.style.clipPath = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`;
    const trackW = track.clientWidth;
    const kw = knob.offsetWidth || 44;
    knob.style.left = `${Math.round(Math.max(0, Math.min(trackW - kw, p * trackW - kw / 2)))}px`;
    valEl.textContent = fmt(toV(p));
  };

  // 9-slice the frame/fill into the track box (device-resolution, crisp) and
  // re-bake + reposition the knob on any size change.
  const frameImg = new Image();
  const fillImg = new Image();
  const bakeInto = (el: HTMLImageElement, im: HTMLImageElement) => {
    const w = track.clientWidth;
    const h = track.clientHeight;
    if (w < 2 || h < 2 || !im.complete || !im.naturalWidth) return;
    // hudKitPx: the slider lives in the un-zoomed HUD — its track/fill blocks
    // must track the frame like the plates (the bars get this via uiZoom)
    const u = nineSlice(im, w, h, Math.max(1, window.devicePixelRatio || 1), hudKitPx());
    if (u) el.src = u;
  };
  const rebake = () => {
    bakeInto(frame, frameImg);
    bakeInto(fill, fillImg);
    render(curP);
  };
  frameImg.onload = rebake;
  fillImg.onload = rebake;
  frameImg.src = BAR_FRAME;
  fillImg.src = BAR_FILL;
  new ResizeObserver(rebake).observe(track);

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

  // A REAL touch device (finger keyboard is coming). The maintainer runs the
  // game in normal mobile mode now, where this is reliable — it only reads 0 /
  // false under Chrome's "Request Desktop Site", which the maintainer has
  // accepted won't get the lift ("if that's what they want they should blame
  // themselves"). So this is exactly the right gate: it floats the box on every
  // phone, and leaves a real mouse desktop (no keyboard) alone.
  const touchDevice = () =>
    (navigator.maxTouchPoints || 0) > 0 ||
    window.matchMedia?.("(pointer: coarse)").matches === true;

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
    // the chat log's lines down. ONLY the input may move (maintainer).
    barEl = input.parentElement;
    if (barEl) barEl.style.height = `${Math.round(barEl.getBoundingClientRect().height)}px`;
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
  const isChatInput = (t: EventTarget | null) =>
    t instanceof HTMLElement && t.classList.contains("ml-chat-input");
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
  // Android ▼/Back hides the keyboard WITHOUT blurring the field, and on a device
  // that reports no keyboard height we can't detect that — the floated box would
  // hover over the game with no keyboard beneath it. The user's next tap OUTSIDE
  // the box means they're done: blur it (→ focusout → drop). Tapping the box
  // itself keeps focus so you can keep typing.
  addEventListener("pointerdown", (e) => {
    if (lifted && input && e.target !== input) input.blur();
  }, { capture: true, passive: true });
  vk?.addEventListener("geometrychange", sync);
  vv?.addEventListener("resize", sync);
  vv?.addEventListener("scroll", sync);
}

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  mountChatKeyboardLift();
  // --ml-hud-scale (the frame's HUD_SCALE, frame2) still scales the tab
  // label font + legacy border width; button SIZES are fixed px now
  // (maintainer: tabs and settings buttons both 120px).
  document.documentElement.style.setProperty("--ml-hud-scale", String(HUD_SCALE));
  // --ml-tab: PERFECT-SQUARE tab plate side (mock plates capped at 150).
  // --ml-tabzone: boundary → divider B line centre; tracks the tab size.
  // Frame pieces are mock-ABSOLUTE crops: corners 180px, borders as
  // segment strips stretched between fixed junctions (see build-ui-tiles).
  const css = `
  :root{--ml-hud-scale:1;
    /* tab plate side == the backpack SLOT side (128px * --ml-fs, the frame
       scale) so the menu buttons are the SAME SIZE as the slots at EVERY
       viewport (maintainer 2026-07-25: they diverged in mobile view — the old
       min(120px, vw-formula) tracked neither the frame nor the slots). Six
       fit the tab-row window at any width: it and the 5-slot window are the
       same width, and 6*128*fs stays ~83% of it (the rest is gaps). */
    --ml-tab:calc(128px * var(--ml-fs, 0.75));
    --ml-bw:calc(26px * var(--ml-hud-scale))}   /* plate border render width */
  /* HUD sections: base props only — position/size come from applyFrameLayout
     (the frame-v2 windows), set inline after every compose. */
  /* the band behind the menu buttons: the KIT's pop-up panel brown
     (80,60,51) — the tone its own buttons sit on. Brighter than the old
     #23160d plate-sheet backdrop (maintainer, repeatedly). */
  .ml-hud{position:fixed;left:0;right:0;bottom:0;z-index:4;background:#503c33;box-sizing:border-box}
  .ml-tabrow{position:absolute;display:flex;justify-content:space-evenly;align-items:center}
  /* tabs carry the SAME kit trio as the settings buttons (dressPlate in the
     constructor): brown Normal, cream Selected, dark Down while held */
  .ml-tab{width:var(--ml-tab);height:var(--ml-tab);flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
    padding:2px 0;cursor:pointer;image-rendering:pixelated;box-sizing:border-box;
    touch-action:manipulation;-webkit-touch-callout:none;border:none;
    background:none;background-repeat:no-repeat;background-size:100% 100%}
  /* icon-only tabs (maintainer: "icon is enough"). The icon SCALES WITH THE
     PLATE — 78% of --ml-tab — so it tracks the frame like the slot art does and
     keeps the SAME icon-to-plate ratio at every viewport (at the design width
     that's the 96px 2x bake rendered ~1:1, the approved look). A FIXED 96px icon
     (halved to 48px under 780px) read "too small and wrong" in mobile view
     (maintainer 2026-07-25): it OVERFLOWED a small plate and shrank to a
     thick-bordered dot on a wide-mobile one — it never tracked the plate. */
  .ml-tab-icon{width:calc(var(--ml-tab) * 0.78);height:calc(var(--ml-tab) * 0.78);
    image-rendering:pixelated;-webkit-user-drag:none;pointer-events:none}
  .ml-pages{position:absolute;overflow:hidden;image-rendering:pixelated}
  /* pages sit on the SAME plain kit-panel brown as the tab-row band
     (maintainer 2026-07-18: no more stone backdrop — "the same plain
     bg-color as we have under the menu buttons"); /ui2/stone.png stays
     shipped if the cobble look is ever wanted back */
  /* 'safe center' keeps a short page centred but FALLS BACK to top-anchored
     the instant the content is taller than the page (settings: ~12 buttons +
     the ambient checklist overflow a phone). A plain justify-content:center
     clips the top row OUT of scroll range — the maintainer: "always see the
     top UI on that page before we scroll." overflow-y:auto then scrolls it. */
  .ml-page{display:none;height:100%;overflow-y:auto;overflow-x:hidden;
    -webkit-overflow-scrolling:touch;flex-direction:column;align-items:center;
    justify-content:safe center;gap:14px;text-align:center;box-sizing:border-box;
    padding:var(--ml-page-padtop,14px) var(--ml-page-pad,44px) var(--ml-page-padbot,14px);
    background:#503c33;image-rendering:pixelated}
  .ml-page.show{display:flex}
  /* gamepad page: the analog stick positions absolutely inside it */
  .ml-page[data-page=gamepad]{position:relative;overflow:hidden}
  /* map page: the world's iso minimap centred in the page with a red "you are here"
     dot. .ml-map-frame is JS-sized to the fitted image (buildMap.fitMap) so it
     equals the displayed image box — the dot's percent offsets then land on the
     right pixel with no letterbox skew. Pixel-art: nearest-neighbour. */
  .ml-page[data-page=map]{overflow:hidden}
  .ml-map{flex:1 1 auto;min-height:0;width:100%;display:flex;
    align-items:center;justify-content:center;overflow:hidden}
  .ml-map-frame{position:relative;line-height:0;flex:none}
  .ml-map-frame[hidden]{display:none}
  .ml-map-img{display:block;width:100%;height:100%;image-rendering:pixelated;
    -webkit-user-drag:none;pointer-events:none}
  .ml-map-dot{position:absolute;left:50%;top:50%;width:14px;height:14px;
    transform:translate(-50%,-50%);border-radius:50%;background:#e8382c;
    border:2px solid #fff;box-sizing:border-box;pointer-events:none;
    box-shadow:0 0 5px rgba(0,0,0,.7);z-index:1}
  .ml-map-empty{color:#f0e2c6;font:700 16px system-ui,sans-serif;
    text-align:center;padding:24px;line-height:1.5}
  .ml-map-empty[hidden]{display:none}
  /* backpack slots: the kit's empty-slot square (maintainer circled it),
     9-sliced by dressSlot to fill the box at the SAME KIT_PX block size as
     the buttons ("this slot should look very much like an empty button").
     The box still rides the frame's scale (--ml-fs). */
  .ml-slots{display:grid;grid-template-columns:repeat(5,calc(128px * var(--ml-fs,0.75)));
    grid-template-rows:repeat(3,calc(128px * var(--ml-fs,0.75)));
    justify-content:space-evenly;align-content:space-evenly;width:100%;height:100%}
  .ml-slot{width:calc(128px * var(--ml-fs,0.75));height:calc(128px * var(--ml-fs,0.75));
    image-rendering:pixelated;border:none;box-sizing:border-box;
    background-repeat:no-repeat;background-size:100% 100%}
  /* settings "menu buttons": SAME page geometry as the backpack grid
     (maintainer: the buttons must respect the backpack view's distances
     from left/top/right, and its spacing). Like .ml-slots: the grid fills
     the page window and space-evenly distributes — outer margin equals the
     gap between items. The column width is DERIVED so the horizontal gap
     equals the backpack's slot gap g=(100% - 5*128px*fs)/6: three columns
     leave 4 gaps, so col=(100% - 4g)/3. Fixed columns (not 1fr) also keep
     a state label changing on press from resizing/reflowing the row
     (maintainer: the buttons no longer move around; 3 per row). */
  .ml-btnrow{display:grid;width:100%;height:100%;
    grid-template-columns:repeat(3,calc((100% - 4*(100% - 640px*var(--ml-fs,0.75))/6)/3));
    justify-content:space-evenly;align-content:space-evenly}
  /* the wide Log out button at the top of Settings (maintainer 2026-07-23):
     a full ROW — width respects the SAME outer margin g as the backpack/settings
     grids (full width minus a slot-gap each side), and flex-shrink:0 keeps its
     full row height (min(120px,12.245vw)) instead of collapsing when the
     scrolling settings column overflows */
  .ml-page>.ml-plate-btn{width:calc(100% - (100% - 640px*var(--ml-fs,0.75))/3);
    flex-shrink:0}
  /* UI-KIT plates (maintainer's pack, plate.ts): flat pixel plates composed
     at an INTEGER block scale (floor(h/native/2) — 5px blocks at h=120).
     Height 120 is the maintainer's shared button height, same as the tabs.
     Labels wrap to a second line when the 3-per-row column narrows. White
     uppercase labels like the kit's pop-up rows. */
  /* Design-width normalization (uiscale.ts): the HUD root is NOT uiZoom'd
     (frame-glued geometry), so its fixed sizes scale themselves with
     min(design-px, vw) — exactly the design value at the 980 reference
     layout (the maintainer's desktop-site phone), proportionally smaller on
     device-width viewports (2026-07-22: buttons/fonts read 2x too big
     there). vw is safe here BECAUSE the HUD is never zoomed. */
  .ml-plate-btn{width:100%;white-space:normal;overflow:hidden;
    display:flex;align-items:center;justify-content:center;text-align:center;
    padding:8px min(24px,2.449vw);height:min(120px,12.245vw);box-sizing:border-box;border:none;
    cursor:pointer;image-rendering:pixelated;touch-action:manipulation;
    background:none;background-repeat:no-repeat;background-size:100% 100%;
    font:700 24px system-ui,sans-serif;font-size:min(24px,2.449vw);
    letter-spacing:.6px;text-transform:uppercase;color:#fff;
    text-shadow:0 1px 0 rgba(0,0,0,.35)}
  /* state = the plate art (the kit's Normal/Selected/Down trio via
     dressPlate); the cream SELECTED bar needs a dark label */
  .ml-plate-btn.on{color:#4a2a1c;text-shadow:none}
  .ml-plate-btn.press{color:#f4e3c2}
  /* SETTINGS SCROLL COLUMN: the games button grid stacked over the ambient
     checklist. When it fits, .ml-page 'safe center' centres this column; when
     it overflows it top-anchors + scrolls (rows above stay reachable). */
  .ml-set{display:flex;flex-direction:column;align-items:stretch;gap:20px;width:100%}
  /* the games button grid keeps its 3-col horizontal spacing but now sizes to
     its content (was height:100% to fill+space-evenly the whole page) so the
     ambient list can sit below it and the PAGE — not the grid — scrolls */
  .ml-set .ml-btnrow{height:auto;row-gap:14px}
  /* ambient-effect checklist */
  .ml-amb{display:flex;flex-direction:column;gap:12px;width:100%}
  .ml-amb-title{border-top:2px solid rgba(0,0,0,.28);padding-top:14px;
    color:#f0e2c6;font:700 18px system-ui,sans-serif;font-size:min(18px,1.837vw);
    letter-spacing:1px;text-transform:uppercase;text-align:center}
  .ml-amb-list{display:flex;flex-direction:column;gap:12px;width:100%}
  /* a checkbox row: kit plate bar, checkbox on the LEFT, label left-aligned.
     Overrides .ml-plate-btn's centred/tall defaults (declared after it so the
     equal-specificity rules win by source order). */
  .ml-amb-row{justify-content:flex-start;gap:18px;height:min(72px,7.347vw);text-align:left;
    padding:8px 22px;white-space:nowrap;text-transform:uppercase}
  /* the kit checkbox (8px native): INTEGER multiples only (5x/3x/2x — see the
     narrow-viewport media queries) so every art pixel stays crisp */
  .ml-amb-check{width:40px;height:40px;flex:none;image-rendering:pixelated;
    -webkit-user-drag:none;pointer-events:none}
  .ml-amb-label{overflow:hidden;text-overflow:ellipsis}
  /* blocked = an incompatible effect is on: greyed + not-tappable-looking (the
     tap is a harmless no-op; the label already says which effect blocks it) */
  .ml-amb-row.blocked{opacity:.5;cursor:not-allowed}
  .ml-amb-auto{margin-bottom:2px}
  /* Bird-density slider (kit bar art track + plate knob). Sits under the
     checklist; scales both bird flocks 0.1×–10×. */
  .ml-amb-slider{display:flex;flex-direction:column;gap:10px;width:100%}
  .ml-amb-slider-head{display:flex;justify-content:space-between;align-items:baseline;
    color:#f0e2c6;font:700 16px system-ui,sans-serif;font-size:min(16px,1.633vw);
    letter-spacing:1px;text-transform:uppercase}
  .ml-amb-slider-val{color:#ffd678;font-variant-numeric:tabular-nums}
  /* touch-action:none so a horizontal drag never scrolls the settings page */
  .ml-slider{position:relative;width:100%;height:30px;touch-action:none;cursor:pointer}
  .ml-slider-frame,.ml-slider-fill{position:absolute;inset:0;width:100%;height:100%;
    image-rendering:pixelated;-webkit-user-drag:none;pointer-events:none}
  .ml-slider-fill{will-change:clip-path}
  /* the knob is purely visual (the track owns all pointer events); JS sets left */
  .ml-slider-knob{position:absolute;top:50%;left:0;width:44px;height:44px;translate:0 -50%;
    background-size:100% 100%;background-repeat:no-repeat;image-rendering:pixelated;
    pointer-events:none}
  /* CHAT page: a scrolling message history over a full-width input pinned to
     the bottom. The PAGE itself doesn't scroll (like the map page) — the log
     inside it does, so the input bar stays put. px/vw sizes only (the HUD root
     is never uiZoom'd; vw is safe here, same as the plate buttons). */
  .ml-page[data-page=chat]{overflow:hidden;justify-content:flex-start}
  .ml-chat{flex:1 1 auto;min-height:0;width:100%;display:flex;flex-direction:column;gap:12px}
  .ml-chat-log{flex:1 1 auto;min-height:0;width:100%;overflow-y:auto;overflow-x:hidden;
    -webkit-overflow-scrolling:touch;display:flex;flex-direction:column;gap:5px;
    text-align:left;font:400 22px system-ui,sans-serif;font-size:min(22px,2.245vw);
    color:#e8e8f0;line-height:1.4;text-shadow:0 1px 2px #000}
  /* day divider — the SAME look as the Settings section header (.ml-amb-title):
     a top rule with a centred label, here the real-clock date (YYYY-MM-DD). */
  .ml-chat-day{border-top:2px solid rgba(0,0,0,.28);padding-top:14px;margin-top:6px;
    color:#f0e2c6;font:700 18px system-ui,sans-serif;font-size:min(18px,1.837vw);
    letter-spacing:1px;text-transform:uppercase;text-align:center;text-shadow:none}
  .ml-chat-line{overflow-wrap:anywhere}
  /* fixed-width time so names line up; muted so it doesn't fight the message */
  .ml-chat-time{color:#9a9aa8;margin-right:8px;font-variant-numeric:tabular-nums}
  .ml-chat-who{color:#ffd678;font-weight:600}
  /* inset the input from the content edges so its box clears the vine rails and
     bottom-corner art (maintainer: "needs more space to the left and right").
     box-sizing:border-box keeps the padding inside the 100% width. */
  .ml-chat-inputbar{flex:none;width:100%;box-sizing:border-box;padding:0 min(40px,5vw)}
  .ml-chat-input{width:100%;box-sizing:border-box;padding:min(14px,1.5vw) min(18px,1.9vw);
    border-radius:8px;border:1px solid #2c2c31;background:#0a0a0cee;color:#fff;
    font:400 22px system-ui,sans-serif;font-size:min(22px,2.245vw)}
  .ml-chat-input::placeholder{color:#8a8a96}
  /* Phone keyboard: the world + HUD stay put (virtualKeyboard.overlaysContent —
     the keyboard is drawn on top, the browser doesn't scroll/reflow the game).
     While a chat input is focused and the keyboard is up (.ml-kb-up, driven by
     mountChatKeyboardLift), float ONLY that input up so you can SEE what you type
     (maintainer). Its left/right match the in-HUD input inset, so it rises straight
     up without changing width, and the transition GLIDES it up, not a snap.

     WHERE it lands: --ml-inputlift = --ml-kb + 10 (just above the keyboard).
     --ml-kb itself is floored (kbHeight, JS) so the box always clears the frame's
     bottom rail — at --ml-kb+10 alone it sat DOWN IN the rail art (maintainer:
     "too low, renders under the frame"). The on-screen chat log is pushed up above
     it (.ml-kb-up .ml-chatlog below) to make room. Never fires on desktop (no
     keyboard → --ml-kb stays 0, the class never sets). */
  :root{--ml-inputlift:calc(var(--ml-kb,0px) + 10px)}
  .ml-kb-up .ml-chat-input:focus{position:fixed;z-index:50;width:auto;
    left:calc(var(--ml-page-pad,44px) + min(40px,5vw));
    right:calc(var(--ml-page-pad,44px) + min(40px,5vw));
    bottom:var(--ml-inputlift);box-shadow:0 -2px 16px rgba(0,0,0,.55);
    transition:bottom .15s ease-out}
  /* The on-screen "game-view" chat log (chat.ts .ml-chatlog) is pushed up above
     the floated input box so the box doesn't cover it (maintainer: "translate the
     game-view chat higher up to make room for the text-input"). Two-class
     specificity beats chat.ts's .ml-chatlog rule; only active while lifted.
     --ml-inputlift + the box height + a gap = the box's top edge in LAYOUT px;
     .ml-chatlog carries the compensating uiZoom (uiscale.ts) so its bottom is in
     PRE-zoom space — divide by --ml-uizoom, matching chat.ts's own bottom calc. */
  .ml-kb-up .ml-chatlog{bottom:calc((var(--ml-inputlift) + 64px) / var(--ml-uizoom, 1))}
  /* Narrower-than-design viewports: the tab plate + icon now BOTH scale with
     --ml-fs (the frame scale), so they shrink smoothly with the slots — no
     icon-halving / tab-cap breakpoints are needed any more (those made the
     icon stop tracking the plate). The ambient checkboxes (8px native) still
     step on their own proportional breaks: 5x → 3x → 2x, never fractional. */
  @media (max-width:650px){
    .ml-amb-check{width:24px;height:24px}
  }
  @media (max-width:460px){
    .ml-amb-check{width:16px;height:16px}
  }
  /* Short viewports (small desktop windows): compact everything. Height 48
     keeps the kit rows on an exact integer scale (48 = 4 blocks of 12). */
  @media (max-height:640px){
    /* tab plate/icon scale with --ml-fs (height-constrained here → small frame
       → small plate), so no --ml-tab cap or icon-halving is needed. */
    .ml-page{gap:8px}
    .ml-plate-btn{padding:4px 12px;height:48px;font-size:13px}
    .ml-set{gap:12px}
    .ml-set .ml-btnrow{row-gap:8px}
    .ml-amb{gap:8px}
    .ml-amb-list{gap:8px}
    .ml-amb-title{padding-top:8px;font-size:14px}
    .ml-amb-row{height:44px;gap:12px;padding:4px 12px}
    /* 24 = 3x the 8px art — integer; the earlier 28 was a fractional 3.5x */
    .ml-amb-check{width:24px;height:24px}
    .ml-amb-slider{gap:6px}
    .ml-amb-slider-head{font-size:14px}
    .ml-slider{height:24px}
    .ml-slider-knob{width:36px;height:36px}
    .ml-chat{gap:8px}
    .ml-chat-log{font-size:15px;gap:3px}
    /* match .ml-amb-title's compact size (padding-top:8px;font-size:14px) so the
       day divider still looks like the Settings header on short viewports */
    .ml-chat-day{padding-top:8px;font-size:14px}
    .ml-chat-input{font-size:15px;padding:8px 12px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

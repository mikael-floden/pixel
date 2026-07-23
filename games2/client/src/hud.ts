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
import { dressPlate, dressSlot, readyPlates, repaintPlates } from "./plate";
import { holdLoading } from "./loading";
import { mountGamepadStick } from "./gamepad";
import { mountBars } from "./bars";
import { gameAudio } from "../../composer/index";

// ── Ambient-effect switches (Settings) ───────────────────────────────────
// The ambient-life agent (ambient/) exposes a per-effect TOGGLE controller on
// window.__mlAmbient: several COMPATIBLE effects can run at once, but an effect
// can't switch on while an incompatible one is active (each declares its
// `conflicts`). We render a checkbox list from it — data-driven, so a conflict
// the ambient agent adds/drops updates the UI with no code change here. See
// ambient/README.md "Toggling effects independently".
const CHECK_ON = "/ui2/kit-check-on.png";
const CHECK_OFF = "/ui2/kit-check-off.png";
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
  { id: "logout", label: "Logout" },
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
      dressPlate(b, kindForState); // the kit trio, same as the settings rows
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
    dressPlate(b, kindForState);
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

    // Equipment + Map pages: bare stone until their real content lands
    // (maintainer 2026-07-17: no placeholder text).

    // Settings: home of ALL the toggles mobile can't reach by keyboard. The
    // page now stacks the games button grid OVER the ambient-effect checklist
    // inside one scrolling column (.ml-set) — with ~12 buttons + 8 effects it
    // overflows a phone, so .ml-page scrolls from the top (see injectStyles:
    // "safe center").
    const st = this.pages.get("settings")!;
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
        dressPlate(el, kindForState);
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

    // Logout: deliberate two-step (a stray tap must not eject anyone) —
    // just the button, no explainer text (maintainer 2026-07-17).
    const lo = this.pages.get("logout")!;
    lo.append(plateButton("Log out", () => this.actions.onLogout()));
  }
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

let injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
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
    /* one shared button height (maintainer: both 120px), guarded so SIX
       tabs (gamepad joined 2026-07-22) still fit between the rails on
       narrow real-device viewports */
    --ml-tab:min(120px,calc((100vw - 200px)/6));
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
  /* icon-only tabs (maintainer: "icon is enough"). The icon files are
     exact 2x bakes of the true pixel art — render them 1:1 CSS px (= 2x
     zoom of the art, maintainer). The old contain-fit scaled each icon
     ~1.4x non-integer ("half pixel offset" mush). */
  .ml-tab-icon{image-rendering:pixelated;-webkit-user-drag:none;pointer-events:none}
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
  /* a lone page-level button (Logout): wide is fine (maintainer), but it
     respects the SAME outer margin g as the backpack/settings grids —
     full width minus a slot-gap on each side */
  .ml-page>.ml-plate-btn{width:calc(100% - (100% - 640px*var(--ml-fs,0.75))/3)}
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
  /* Narrower-than-design viewports: the tab plates already shrink via the
     --ml-tab formula, but the ICON files (uniform 96px 2x bakes) overflow
     once a tab drops under 96px — with six tabs that's below a ~780px
     viewport. Icons then drop to exactly HALF the file (= the art's true
     1x, 48px): the only other integer-crisp scale. The ambient checkboxes
     (8px native) step on their own proportional breaks: 5x → 3x → 2x,
     never fractional. */
  @media (max-width:780px){
    .ml-tab-icon{zoom:0.5}
  }
  @media (max-width:650px){
    .ml-amb-check{width:24px;height:24px}
  }
  @media (max-width:460px){
    /* six 48px half-scale icons need more row than the 200px side allowance
       leaves — widen the row (40px insets) and size tabs to it */
    .ml-tabrow{left:40px;right:40px}
    :root{--ml-tab:min(120px,calc((100vw - 100px)/6))}
    .ml-amb-check{width:16px;height:16px}
  }
  /* Short viewports (small desktop windows): compact everything. Height 48
     keeps the kit rows on an exact integer scale (48 = 4 blocks of 12). */
  @media (max-height:640px){
    :root{--ml-tab:min(84px,calc((100vw - 200px)/6))}
    /* compact tabs (≤84px) can't hold the full 96px icon files either */
    .ml-tab-icon{zoom:0.5}
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
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

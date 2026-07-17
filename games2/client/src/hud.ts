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

import { mountFrame2, FrameLayout } from "./frame2";
import { setClockMount } from "./clock";

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

const TABS = [
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
  document.getElementById("ml-pageframe")?.remove(); // old overlay, if any
  mountFrame2((l) => {
    lastLayout = l;
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

  constructor(private actions: HudActions) {
    injectStyles();
    document.querySelector(".ml-hud")?.remove(); // idempotent across re-joins
    const hud = mk("div", "ml-hud");
    const tabRow = mk("div", "ml-tabrow");
    const pageWrap = mk("div", "ml-pages");

    for (const t of TABS) {
      const b = mk("button", "ml-tab") as HTMLButtonElement;
      b.dataset.tab = t.id;
      const icon = mk("img", "ml-tab-icon") as HTMLImageElement;
      icon.src = `/ui2/icon-${t.id}.png`;
      icon.alt = "";
      icon.draggable = false;
      const label = mk("span", "ml-tab-label");
      label.textContent = t.label;
      b.append(icon, label);
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
    applyFrameLayout(); // adopt the frame windows if the frame is already composed
  }

  private select(id: TabId) {
    for (const [tid, b] of this.tabs) b.classList.toggle("sel", tid === id);
    for (const [tid, p] of this.pages) p.classList.toggle("show", tid === id);
  }

  /** Re-read every switch's pressed state AND every live state label
   * (keyboard toggles + server syncs change them too). */
  refreshSettings() {
    for (const [b, get] of this.switches) b.classList.toggle("on", !!get());
    for (const [b, entry] of this.stateful) b.textContent = `${entry.label}: ${entry.state!()}`;
  }

  private buildPages() {
    // Backpack: 5x3 empty item slots, each slot as big as a tab button
    // (maintainer) — the pressed plate doubles as a slot, like the mock's
    // content page. Real inventory comes later.
    const bp = this.pages.get("backpack")!;
    const slots = mk("div", "ml-slots");
    for (let i = 0; i < 15; i++) slots.appendChild(mk("i", "ml-slot"));
    bp.append(slots);

    this.pages.get("equipment")!.append(muted("Nothing equipped yet — armor and tools are coming."));
    this.pages.get("map")!.append(muted("The cartographers are still charting Nangijala."));

    // Settings: home of ALL the toggles mobile can't reach by keyboard.
    const st = this.pages.get("settings")!;
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
    st.appendChild(row);

    // Logout: deliberate two-step (a stray tap must not eject anyone).
    const lo = this.pages.get("logout")!;
    lo.append(
      muted("Leave the world and return to the character select?"),
      plateButton("Log out", () => this.actions.onLogout()),
    );
  }
}

function plateButton(label: string, onPress: () => void): HTMLButtonElement {
  const b = mk("button", "ml-plate-btn") as HTMLButtonElement;
  b.textContent = label;
  b.addEventListener("click", onPress);
  pressFx(b);
  return b;
}

/** Momentary pressed-plate feedback via pointer events: CSS :active is
 * hover-only (mobile Chrome keeps it sticky on the last tap), so touch needs
 * its own press state — added on finger-down, gone the instant the finger
 * lifts or leaves, so it can never stick. */
function pressFx(b: HTMLElement) {
  b.addEventListener("pointerdown", () => b.classList.add("press"));
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    b.addEventListener(ev, () => b.classList.remove("press"));
}

function muted(text: string): HTMLElement {
  const p = mk("p", "ml-muted");
  p.textContent = text;
  return p;
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
  // --ml-tab: PERFECT-SQUARE tab plate side (mock plates capped at 150).
  // --ml-tabzone: boundary → divider B line centre; tracks the tab size.
  // Frame pieces are mock-ABSOLUTE crops: corners 180px, borders as
  // segment strips stretched between fixed junctions (see build-ui-tiles).
  const css = `
  :root{--ml-tab:min(150px,calc((100vw - 200px)/5))}
  /* HUD sections: base props only — position/size come from applyFrameLayout
     (the frame-v2 windows), set inline after every compose. */
  .ml-hud{position:fixed;left:0;right:0;bottom:0;z-index:4;background:#23160d;box-sizing:border-box}
  .ml-tabrow{position:absolute;display:flex;justify-content:space-evenly;align-items:center}
  .ml-tab{width:var(--ml-tab);height:var(--ml-tab);flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
    padding:2px 0;cursor:pointer;image-rendering:pixelated;box-sizing:border-box;
    touch-action:manipulation;-webkit-touch-callout:none;
    border-style:solid;border-width:26px;border-image:url(/ui2/plate-normal.png) 56 fill / 26px;
    background:none}
  /* :active only where a real hover exists — mobile Chrome keeps :active
     sticky on the last-tapped element, which made switches read "pressed"
     regardless of their .on state (maintainer). */
  @media (hover:hover){
  .ml-tab:active{border-image:url(/ui2/plate-pressed.png) 56 fill / 26px}
  }
  .ml-tab.sel{border-image:url(/ui2/plate-selected.png) 56 fill / 26px}
  /* .press after .sel so a finger on the selected tab still reads pressed */
  .ml-tab.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 26px}
  .ml-tab-icon{image-rendering:pixelated;-webkit-user-drag:none;pointer-events:none;
    max-width:calc(100% - 6px);max-height:calc(100% - 22px);object-fit:contain}
  .ml-tab-label{font:700 11px/1.1 system-ui,sans-serif;font-size:clamp(6.5px,1.42vw,12px);
    text-transform:uppercase;color:#dfe2ea;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;max-width:100%}
  .ml-tab.sel .ml-tab-label{color:#ffd678}
  .ml-pages{position:absolute;overflow:hidden;image-rendering:pixelated}
  .ml-page{display:none;height:100%;overflow:auto;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;text-align:center;box-sizing:border-box;
    padding:var(--ml-page-padtop,14px) var(--ml-page-pad,44px) var(--ml-page-padbot,14px);
    background-image:url(/ui2/stone.png);background-size:100% auto;
    background-repeat:repeat-y;background-attachment:local;image-rendering:pixelated}
  .ml-page.show{display:flex}
  .ml-muted{margin:0;font:14px/1.4 system-ui,sans-serif;color:#8f8f9c;text-shadow:0 1px 2px #000}
  .ml-slots{display:grid;grid-template-columns:repeat(5,var(--ml-tab));grid-template-rows:repeat(3,var(--ml-tab));
    justify-content:space-evenly;align-content:space-evenly;width:100%;height:100%}
  .ml-slot{width:var(--ml-tab);height:var(--ml-tab);image-rendering:pixelated;border-style:solid;border-width:30px;
    border-image:url(/ui2/slot.png) 10 fill / 30px;box-sizing:border-box}
  .ml-btnrow{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;max-width:100%}
  /* settings buttons must never be SHORTER than the menu tabs / backpack
     slots (maintainer) — same --ml-tab height, width still fits the label */
  .ml-plate-btn{padding:10px 20px;min-height:var(--ml-tab);box-sizing:border-box;
    cursor:pointer;image-rendering:pixelated;background:none;touch-action:manipulation;
    border-style:solid;border-width:26px;border-image:url(/ui2/plate-normal.png) 56 fill / 26px;
    font:700 14px system-ui,sans-serif;letter-spacing:.4px;text-transform:uppercase;color:#e8e8ec;
    text-shadow:0 1px 2px #000}
  @media (hover:hover){
  .ml-plate-btn:active{border-image:url(/ui2/plate-pressed.png) 56 fill / 26px;color:#ffd678}
  }
  .ml-plate-btn.on{border-image:url(/ui2/plate-pressed.png) 56 fill / 26px;color:#ffd678}
  .ml-plate-btn.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 26px;color:#ffd678}
  /* Narrow phones: five square tabs must still fit between the outer rails. */
  @media (max-width:460px){
    .ml-tabrow{left:40px;right:40px}
    .ml-tab{border-width:13px;border-image-width:13px}
    .ml-tab.sel{border-width:13px;border-image-width:13px}
    .ml-tab.press{border-width:13px;border-image-width:13px}
  }
  /* Short viewports (small desktop windows): compact everything. */
  @media (max-height:640px){
    :root{--ml-tab:min(84px,calc((100vw - 200px)/5))}
    .ml-page{gap:8px}
    .ml-plate-btn{padding:6px 14px;border-width:13px;border-image-width:13px;font-size:11px}
    .ml-plate-btn.on{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
    .ml-plate-btn.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
    .ml-slot{border-width:20px;border-image-width:20px}
    .ml-muted{font-size:11px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

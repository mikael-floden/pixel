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
import { dressPlate, dressSlot, repaintPlates } from "./plate";
import { gameAudio } from "../../composer/index";

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
  // the version badge sits bottom-centre of the GAME VIEW: lift it above
  // the HUD only when the HUD actually lays out (main.ts showVersion)
  root.style.setProperty("--ml-badge-lift", `${Math.round(window.innerHeight - l.railTop)}px`);
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
      b.addEventListener("click", () => {
        this.select(t.id);
        gameAudio.event("ui.cursor_move"); // tab tick (menu_select binding)
      });
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
  }

  /** Re-read every switch's pressed state AND every live state label
   * (keyboard toggles + server syncs change them too). */
  refreshSettings() {
    for (const [b, get] of this.switches) b.classList.toggle("on", !!get());
    for (const [b, entry] of this.stateful)
      (b.firstElementChild ?? b).textContent = `${entry.label}: ${entry.state!()}`;
  }

  private buildPages() {
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
  b.addEventListener("click", () => {
    gameAudio.event("ui.confirm");
    onPress();
  });
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
  b.addEventListener("pointerdown", () => b.classList.add("press"));
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    b.addEventListener(ev, () => b.classList.remove("press"));
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
    /* one shared button height (maintainer: both 120px), guarded so five
       tabs still fit between the rails on narrow real-device viewports */
    --ml-tab:min(120px,calc((100vw - 200px)/5));
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
  .ml-tab-icon{image-rendering:pixelated;-webkit-user-drag:none;pointer-events:none;
    max-width:calc(100% - 6px);max-height:calc(100% - 22px * var(--ml-hud-scale,1));object-fit:contain}
  /* label font scales with the HUD so it fits the (smaller) square tab plate
     at the 1x experiment size instead of overflowing (maintainer) */
  .ml-tab-label{font:700 11px/1.1 system-ui,sans-serif;
    font-size:calc(clamp(6.5px,1.42vw,12px) * var(--ml-hud-scale,1));
    text-transform:uppercase;color:#fff;text-shadow:0 1px 0 rgba(0,0,0,.35);white-space:nowrap;overflow:hidden;max-width:100%}
  .ml-tab.sel .ml-tab-label{color:#4a2a1c;text-shadow:none}
  .ml-tab.press .ml-tab-label{color:#f4e3c2}
  .ml-pages{position:absolute;overflow:hidden;image-rendering:pixelated}
  .ml-page{display:none;height:100%;overflow:auto;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;text-align:center;box-sizing:border-box;
    padding:var(--ml-page-padtop,14px) var(--ml-page-pad,44px) var(--ml-page-padbot,14px);
    background-image:url(/ui2/stone.png);background-size:100% auto;
    background-repeat:repeat-y;background-attachment:local;image-rendering:pixelated}
  .ml-page.show{display:flex}
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
  /* settings "menu buttons" also opt into x2 (native) so they stay tappable.
     GRID with equal columns (not flex-wrap): every button is the SAME fixed
     size, so a state label changing on press ("time speed: frozen" -> "x2",
     "weather: clear sky" -> "cloudy at times") can't resize a button and
     reflow the row — the buttons no longer move around (maintainer). The
     three fixed columns (maintainer: 3 buttons per row). */
  .ml-btnrow{display:grid;grid-template-columns:repeat(3,1fr);
    gap:12px;justify-content:center;align-items:stretch;width:100%;margin:0 auto}
  /* UI-KIT plates (maintainer's pack, plate.ts): flat pixel plates composed
     at an INTEGER block scale (floor(h/native/2) — 5px blocks at h=120).
     Height 120 is the maintainer's shared button height, same as the tabs.
     Labels wrap to a second line when the 3-per-row column narrows. White
     uppercase labels like the kit's pop-up rows. */
  .ml-plate-btn{width:100%;white-space:normal;overflow:hidden;
    display:flex;align-items:center;justify-content:center;text-align:center;
    padding:8px 24px;height:120px;box-sizing:border-box;border:none;
    cursor:pointer;image-rendering:pixelated;touch-action:manipulation;
    background:none;background-repeat:no-repeat;background-size:100% 100%;
    font:700 15px system-ui,sans-serif;letter-spacing:.6px;text-transform:uppercase;color:#fff;
    text-shadow:0 1px 0 rgba(0,0,0,.35)}
  /* state = the plate art (the kit's Normal/Selected/Down trio via
     dressPlate); the cream SELECTED bar needs a dark label */
  .ml-plate-btn.on{color:#4a2a1c;text-shadow:none}
  .ml-plate-btn.press{color:#f4e3c2}
  /* Narrow phones: five square tabs must still fit between the outer rails. */
  @media (max-width:460px){
    .ml-tabrow{left:40px;right:40px}
  }
  /* Short viewports (small desktop windows): compact everything. Height 48
     keeps the kit rows on an exact integer scale (48 = 4 blocks of 12). */
  @media (max-height:640px){
    :root{--ml-tab:min(84px,calc((100vw - 200px)/5))}
    .ml-page{gap:8px}
    .ml-plate-btn{padding:4px 12px;height:48px;font-size:11px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

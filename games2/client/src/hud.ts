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

export interface HudActions {
  onLogout: () => void;
  /** Settings-tab controls (the keyboard digits' mobile home). Entries with
   * `get` are SWITCHES: the plate renders pressed-down while get() is true
   * (down = ON, up = OFF — maintainer); plain entries are one-shot buttons.
   * The entry with `hook` keeps the .ml-hudbtn class the e2e smoke clicks. */
  settings: { label: string; act: () => void; hook?: boolean; get?: () => boolean }[];
}

const TABS = [
  { id: "backpack", label: "Backpack" },
  { id: "equipment", label: "Equipment" },
  { id: "map", label: "Map" },
  { id: "settings", label: "Settings" },
  { id: "logout", label: "Logout" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Mount the full-page frame overlay: outer corners/rails/gems + the two
 * divider assemblies. Pointer-transparent; positioned by the same CSS vars
 * the HUD layout uses, so the sections always meet the dividers exactly. */
export function mountPageFrame() {
  injectStyles();
  document.getElementById("ml-pageframe")?.remove();
  const f = mk("div", "");
  f.id = "ml-pageframe";
  const group = (cls: string, kids: string[]) => {
    const g = mk("div", `ml-pf ${cls}`);
    for (const k of kids) g.appendChild(mk("i", k));
    f.appendChild(g);
  };
  for (const c of ["tl", "tr", "bl", "br"]) f.appendChild(mk("i", `ml-pf ml-corner-${c}`));
  group("ml-et", ["sl", "gm", "sr"]); // top border between corners
  group("ml-eb", ["sg"]); // bottom border
  group("ml-el", ["v1", "gm", "v2", "v3", "v4"]); // left border segments
  group("ml-er", ["v1", "gm", "v2", "v3", "v4"]); // right border segments
  group("ml-divA", ["cl", "sl", "gm", "sr", "cr"]);
  group("ml-divB", ["cl", "sg", "cr"]);
  document.body.appendChild(f);
}

export class HudBar {
  private pages = new Map<TabId, HTMLElement>();
  private tabs = new Map<TabId, HTMLButtonElement>();
  private switches: [HTMLButtonElement, () => boolean][] = [];

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
      icon.src = `/ui/icon-${t.id}.png`;
      icon.alt = "";
      icon.draggable = false;
      const label = mk("span", "ml-tab-label");
      label.textContent = t.label;
      b.append(icon, label);
      b.addEventListener("click", () => this.select(t.id));
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
  }

  private select(id: TabId) {
    for (const [tid, b] of this.tabs) b.classList.toggle("sel", tid === id);
    for (const [tid, p] of this.pages) p.classList.toggle("show", tid === id);
  }

  /** Re-read every switch's state (keyboard toggles change it too). */
  refreshSettings() {
    for (const [b, get] of this.switches) b.classList.toggle("on", !!get());
  }

  private buildPages() {
    // Backpack: a row of empty item slots (the pressed plate doubles as a
    // slot, like the mock's content page) — real inventory comes later.
    const bp = this.pages.get("backpack")!;
    const slots = mk("div", "ml-slots");
    for (let i = 0; i < 6; i++) slots.appendChild(mk("i", "ml-slot"));
    bp.append(slots, muted("Your backpack is empty… for now."));

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
  return b;
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
  :root{--ml-tab:min(150px,calc((100vw - 200px)/5));--ml-tabzone:calc(var(--ml-tab) + 48px);
    --gemc:calc(var(--hud-h-inv)*0.564)}
  #ml-pageframe{position:fixed;inset:0;z-index:6;pointer-events:none}
  .ml-pf,.ml-pf i{position:absolute;pointer-events:none;image-rendering:pixelated;background-size:100% 100%}
  .ml-corner-tl{left:0;top:0;width:180px;height:180px;background-image:url(/ui/corner-tl.png)}
  .ml-corner-tr{right:0;top:0;width:180px;height:180px;background-image:url(/ui/corner-tr.png)}
  .ml-corner-bl{left:0;bottom:0;width:180px;height:180px;background-image:url(/ui/corner-bl.png)}
  .ml-corner-br{right:0;bottom:0;width:180px;height:180px;background-image:url(/ui/corner-br.png)}
  /* top border: stretch-segments join the corners/gem with identical mock
     pixels on both sides of every joint */
  .ml-et{left:180px;right:180px;top:0;height:76px}
  .ml-et .sl{left:0;right:calc(50% + 28px);top:0;bottom:0;background-image:url(/ui/top-seg-l.png)}
  .ml-et .gm{left:calc(50% - 28px);width:56px;top:0;bottom:0;background-image:url(/ui/gem-top.png)}
  .ml-et .sr{left:calc(50% + 28px);right:0;top:0;bottom:0;background-image:url(/ui/top-seg-r.png)}
  .ml-eb{left:180px;right:180px;bottom:0;height:76px}
  .ml-eb .sg{inset:0;background-image:url(/ui/bottom-seg.png)}
  /* side borders: four clean-rail segments BETWEEN the junctions (corner→gem,
     gem→divA cap, divider-to-divider, divB cap→corner) — junction/ornament
     art lives only in the caps/gem tiles, so vertical stretching only ever
     touches featureless straight rail (invisible; no smeared decor, no
     non-square pixels on features). --gemc = the side gems' centre, at the
     mock's fraction (56.4%) of the game section. */
  .ml-el,.ml-er{top:0;bottom:0;width:76px}
  .ml-el{left:0}
  .ml-er{right:0}
  .ml-el .v1,.ml-el .v2,.ml-el .v3,.ml-el .v4{left:0;width:64px}
  .ml-er .v1,.ml-er .v2,.ml-er .v3,.ml-er .v4{right:0;width:64px}
  .ml-el .gm{left:0;width:76px}
  .ml-er .gm{right:0;width:76px}
  .ml-el .v1,.ml-er .v1{top:180px;height:calc(var(--gemc) - 34px - 180px)}
  .ml-el .gm,.ml-er .gm{top:calc(var(--gemc) - 34px);height:68px}
  .ml-el .v2,.ml-er .v2{top:calc(var(--gemc) + 34px);height:calc(var(--hud-h-inv) - 85px - var(--gemc) - 34px)}
  .ml-el .v3,.ml-er .v3{top:calc(var(--hud-h-inv) + 31px);height:calc(var(--ml-tabzone) - 47px)}
  .ml-el .v4,.ml-er .v4{top:calc(var(--hud-h-inv) + var(--ml-tabzone) + 40px);bottom:180px}
  .ml-el .v1{background-image:url(/ui/left-v1.png)}
  .ml-el .gm{background-image:url(/ui/gem-left.png)}
  .ml-el .v2{background-image:url(/ui/left-v2.png)}
  .ml-el .v3{background-image:url(/ui/left-v3.png)}
  .ml-el .v4{background-image:url(/ui/left-v4.png)}
  .ml-er .v1{background-image:url(/ui/right-v1.png)}
  .ml-er .gm{background-image:url(/ui/gem-right.png)}
  .ml-er .v2{background-image:url(/ui/right-v2.png)}
  .ml-er .v3{background-image:url(/ui/right-v3.png)}
  .ml-er .v4{background-image:url(/ui/right-v4.png)}
  /* divider A: thin line (mock 707..711) centred on the game/HUD boundary;
     the 190px caps own ALL the junction decor (line centre 55px into them) */
  .ml-divA{left:0;right:0;top:calc(var(--hud-h-inv) - 85px);height:116px}
  .ml-divA .cl{left:0;top:0;width:190px;height:116px;background-image:url(/ui/divA-capl.png)}
  .ml-divA .sl{left:190px;right:calc(50% + 28px);top:64px;height:36px;background-image:url(/ui/divA-seg-l.png)}
  .ml-divA .gm{left:calc(50% - 28px);width:56px;top:50px;height:58px;background-image:url(/ui/divA-gem.png)}
  .ml-divA .sr{left:calc(50% + 28px);right:190px;top:64px;height:36px;background-image:url(/ui/divA-seg-r.png)}
  .ml-divA .cr{right:0;top:0;width:190px;height:116px;background-image:url(/ui/divA-capr.png)}
  /* divider B: line centre 16px into the caps / 6px into the 16px seg */
  .ml-divB{left:0;right:0;top:calc(var(--hud-h-inv) + var(--ml-tabzone) - 16px);height:56px}
  .ml-divB .cl{left:0;top:0;width:190px;height:56px;background-image:url(/ui/divB-capl.png)}
  .ml-divB .sg{left:190px;right:190px;top:10px;height:16px;background-image:url(/ui/divB-seg.png)}
  .ml-divB .cr{right:0;top:0;width:190px;height:56px;background-image:url(/ui/divB-capr.png)}
  /* HUD content between the dividers */
  .ml-hud{position:fixed;left:0;right:0;bottom:0;height:var(--hud-h);z-index:4;background:#07070e;box-sizing:border-box}
  .ml-tabrow{position:absolute;top:24px;left:44px;right:44px;height:var(--ml-tab);display:flex;justify-content:space-evenly}
  .ml-tab{width:var(--ml-tab);height:var(--ml-tab);flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
    padding:2px 0;cursor:pointer;image-rendering:pixelated;box-sizing:border-box;
    touch-action:manipulation;-webkit-touch-callout:none;
    border-style:solid;border-width:13px;border-image:url(/ui/plate-unselected.png) 26 fill / 13px;
    background:none}
  .ml-tab:active{border-image:url(/ui/plate-pressed.png) 26 fill / 13px}
  .ml-tab.sel{border-image:url(/ui/plate-selected.png) 32 fill / 16px}
  .ml-tab-icon{image-rendering:pixelated;-webkit-user-drag:none;pointer-events:none;
    max-width:calc(100% - 6px);max-height:calc(100% - 22px);object-fit:contain}
  .ml-tab-label{font:700 11px/1.1 system-ui,sans-serif;font-size:clamp(6.5px,1.42vw,12px);
    text-transform:uppercase;color:#dfe2ea;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;max-width:100%}
  .ml-tab.sel .ml-tab-label{color:#ffd678}
  .ml-pages{position:absolute;left:48px;right:48px;top:calc(var(--ml-tabzone) + 30px);bottom:46px;overflow:hidden}
  .ml-page{display:none;height:100%;overflow:auto;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;text-align:center}
  .ml-page.show{display:flex}
  .ml-muted{margin:0;font:14px/1.4 system-ui,sans-serif;color:#8f8f9c;text-shadow:0 1px 2px #000}
  .ml-slots{display:flex;gap:12px;justify-content:center}
  .ml-slot{width:56px;height:56px;image-rendering:pixelated;border-style:solid;border-width:13px;
    border-image:url(/ui/plate-pressed.png) 26 fill / 13px;box-sizing:border-box}
  .ml-btnrow{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;max-width:100%}
  .ml-plate-btn{padding:14px 26px;cursor:pointer;image-rendering:pixelated;background:none;touch-action:manipulation;
    border-style:solid;border-width:13px;border-image:url(/ui/plate-unselected.png) 26 fill / 13px;
    font:700 14px system-ui,sans-serif;letter-spacing:.4px;text-transform:uppercase;color:#e8e8ec;
    text-shadow:0 1px 2px #000}
  .ml-plate-btn:active{border-image:url(/ui/plate-pressed.png) 26 fill / 13px;color:#ffd678}
  .ml-plate-btn.on{border-image:url(/ui/plate-pressed.png) 26 fill / 13px;color:#ffd678}
  /* Narrow phones: five square tabs must still fit between the outer rails. */
  @media (max-width:460px){
    .ml-tabrow{left:40px;right:40px}
    .ml-tab{border-width:11px;border-image-width:11px}
    .ml-tab.sel{border-image-width:12px}
  }
  /* Short viewports (small desktop windows): compact everything. */
  @media (max-height:640px){
    :root{--ml-tab:min(84px,calc((100vw - 200px)/5));--ml-tabzone:calc(var(--ml-tab) + 38px)}
    .ml-tabrow{top:20px}
    .ml-pages{top:calc(var(--ml-tabzone) + 22px);bottom:38px}
    .ml-page{gap:8px}
    .ml-plate-btn{padding:6px 14px;border-width:12px;border-image-width:12px;font-size:11px}
    .ml-plate-btn.on{border-image:url(/ui/plate-pressed.png) 26 fill / 12px}
    .ml-slot{width:36px;height:36px;border-width:9px;border-image-width:9px}
    .ml-muted{font-size:11px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

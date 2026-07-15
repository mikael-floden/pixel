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
  onCycleTime: () => void;
  onLogout: () => void;
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
  for (const p of [
    "corner-tl",
    "corner-tr",
    "corner-bl",
    "corner-br",
    "rail-top",
    "rail-bottom",
    "rail-left",
    "rail-right",
    "gem-top",
    "gem-left",
    "gem-right",
  ])
    f.appendChild(mk("i", `ml-pf ml-${p}`));
  for (const d of ["divA", "divB"]) {
    const wrap = mk("div", `ml-pf ml-${d}`);
    for (const p of ["left", "rail", "right"]) wrap.appendChild(mk("i", `ml-pf ml-${d}-${p}`));
    if (d === "divA") wrap.appendChild(mk("i", "ml-pf ml-divA-gem"));
    f.appendChild(wrap);
  }
  document.body.appendChild(f);
}

export class HudBar {
  private pages = new Map<TabId, HTMLElement>();
  private tabs = new Map<TabId, HTMLButtonElement>();

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
    document.body.appendChild(hud);
    this.select("backpack");
  }

  private select(id: TabId) {
    for (const [tid, b] of this.tabs) b.classList.toggle("sel", tid === id);
    for (const [tid, p] of this.pages) p.classList.toggle("show", tid === id);
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

    // Settings: home of the toggles mobile can't reach by keyboard.
    const st = this.pages.get("settings")!;
    const time = plateButton("1: time-of-day", () => this.actions.onCycleTime());
    time.classList.add("ml-hudbtn"); // stable hook for the e2e smoke
    st.appendChild(time);

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
  // --ml-tabzone: distance from the game/HUD boundary down to divider B's
  // band centre — the tab row lives between the two dividers.
  const css = `
  :root{--ml-tabzone:130px}
  #ml-pageframe{position:fixed;inset:0;z-index:6;pointer-events:none}
  .ml-pf{position:absolute;pointer-events:none;image-rendering:pixelated}
  .ml-corner-tl{left:0;top:0;width:160px;height:160px;background:url(/ui/corner-tl.png);background-size:160px 160px}
  .ml-corner-tr{right:0;top:0;width:160px;height:160px;background:url(/ui/corner-tr.png);background-size:160px 160px}
  .ml-corner-bl{left:0;bottom:0;width:160px;height:160px;background:url(/ui/corner-bl.png);background-size:160px 160px}
  .ml-corner-br{right:0;bottom:0;width:160px;height:160px;background:url(/ui/corner-br.png);background-size:160px 160px}
  .ml-rail-top{left:150px;right:150px;top:0;height:36px;background:url(/ui/rail-top.png) repeat-x;background-size:80px 36px}
  .ml-rail-bottom{left:150px;right:150px;bottom:0;height:36px;background:url(/ui/rail-bottom.png) repeat-x;background-size:80px 36px}
  .ml-rail-left{top:150px;bottom:150px;left:0;width:36px;background:url(/ui/rail-left.png) repeat-y;background-size:36px 80px}
  .ml-rail-right{top:150px;bottom:150px;right:0;width:36px;background:url(/ui/rail-right.png) repeat-y;background-size:36px 80px}
  .ml-gem-top{top:-20px;left:50%;margin-left:-28px;width:56px;height:72px;background:url(/ui/gem-top.png);background-size:56px 72px}
  .ml-gem-left{left:-20px;top:30%;width:72px;height:56px;background:url(/ui/gem-left.png);background-size:72px 56px}
  .ml-gem-right{right:-20px;top:30%;width:72px;height:56px;background:url(/ui/gem-right.png);background-size:72px 56px}
  /* Divider A (game ↔ tabs): band centre sits exactly on the boundary. */
  .ml-divA{left:0;right:0;top:calc(var(--hud-h-inv) - 40px);height:56px}
  .ml-divA-left{left:-20px;top:0;width:84px;height:56px;background:url(/ui/divA-left.png);background-size:84px 56px}
  .ml-divA-right{right:-20px;top:0;width:84px;height:56px;background:url(/ui/divA-right.png);background-size:84px 56px}
  .ml-divA-rail{left:62px;right:62px;top:24px;height:32px;background:url(/ui/divA-rail.png) repeat-x;background-size:80px 32px}
  .ml-divA-gem{left:50%;margin-left:-28px;top:4px;width:56px;height:52px;background:url(/ui/divA-gem.png);background-size:56px 52px}
  /* Divider B (tabs ↔ content): its band centre 13px into the crop. */
  .ml-divB{left:0;right:0;top:calc(var(--hud-h-inv) + var(--ml-tabzone) - 7px);height:58px}
  .ml-divB-left{left:-20px;top:0;width:44px;height:58px;background:url(/ui/divB-left.png);background-size:44px 58px}
  .ml-divB-right{right:-20px;top:0;width:44px;height:58px;background:url(/ui/divB-right.png);background-size:44px 58px}
  .ml-divB-rail{left:22px;right:22px;top:0;height:20px;background:url(/ui/divB-rail.png) repeat-x;background-size:80px 20px}
  /* HUD content between the dividers */
  .ml-hud{position:fixed;left:0;right:0;bottom:0;height:var(--hud-h);z-index:4;background:#07070e;box-sizing:border-box}
  .ml-tabrow{position:absolute;top:30px;left:44px;right:44px;height:86px;display:flex;gap:8px;justify-content:center}
  .ml-tab{flex:1;max-width:150px;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
    padding:2px 0;cursor:pointer;image-rendering:pixelated;
    border-style:solid;border-width:14px;border-image:url(/ui/plate-unselected.png) 26 fill / 14px;
    background:none}
  .ml-tab:active{border-image:url(/ui/plate-pressed.png) 26 fill / 14px}
  .ml-tab.sel{border-image:url(/ui/plate-selected.png) 32 fill / 15px}
  .ml-tab-icon{height:38px;image-rendering:pixelated;-webkit-user-drag:none}
  .ml-tab-label{font:700 11px/1.1 system-ui,sans-serif;font-size:clamp(6.5px,1.42vw,11px);
    text-transform:uppercase;color:#dfe2ea;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;max-width:100%}
  .ml-tab.sel .ml-tab-label{color:#ffd678}
  .ml-pages{position:absolute;left:48px;right:48px;top:calc(var(--ml-tabzone) + 26px);bottom:42px;overflow:hidden}
  .ml-page{display:none;height:100%;overflow:auto;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;text-align:center}
  .ml-page.show{display:flex}
  .ml-muted{margin:0;font:14px/1.4 system-ui,sans-serif;color:#8f8f9c;text-shadow:0 1px 2px #000}
  .ml-slots{display:flex;gap:12px;justify-content:center}
  .ml-slot{width:56px;height:56px;image-rendering:pixelated;border-style:solid;border-width:13px;
    border-image:url(/ui/plate-pressed.png) 26 fill / 13px;box-sizing:border-box}
  .ml-plate-btn{padding:14px 26px;cursor:pointer;image-rendering:pixelated;background:none;
    border-style:solid;border-width:16px;border-image:url(/ui/plate-unselected.png) 26 fill / 16px;
    font:700 14px system-ui,sans-serif;letter-spacing:.4px;text-transform:uppercase;color:#e8e8ec;
    text-shadow:0 1px 2px #000}
  .ml-plate-btn:active{border-image:url(/ui/plate-pressed.png) 26 fill / 16px;color:#ffd678}
  /* Narrow phones: five tabs must still fit between the outer rails. */
  @media (max-width:460px){
    .ml-tabrow{left:40px;right:40px;gap:5px}
    .ml-tab{border-width:11px;border-image-width:11px}
    .ml-tab.sel{border-image-width:12px}
    .ml-tab-icon{height:30px}
  }
  /* Short viewports (small desktop windows): compact everything. */
  @media (max-height:640px){
    :root{--ml-tabzone:104px}
    .ml-tabrow{top:24px;height:66px}
    .ml-tab-icon{height:24px}
    .ml-pages{top:calc(var(--ml-tabzone) + 18px);bottom:34px}
    .ml-page{gap:8px}
    .ml-plate-btn{padding:6px 14px;border-width:12px;border-image-width:12px;font-size:11px}
    .ml-slot{width:36px;height:36px;border-width:9px;border-image-width:9px}
    .ml-muted{font-size:11px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

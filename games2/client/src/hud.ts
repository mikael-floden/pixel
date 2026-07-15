/**
 * Bottom HUD — the page below the golden-ratio split (index.html keeps #game
 * to the top 61.8dvh; this dock owns the bottom 38.2dvh; --hud-h on :root).
 *
 * Structure (per the maintainer's concept art, cut into tiles by
 * scripts/build-ui-tiles.mjs → /ui/*.png):
 *   [ tab row    ]  Backpack · Equipment · Map · Settings · Logout
 *   [ page frame ]  content of the selected tab
 * Both boxes — and the game viewport itself (mountGameFrame) — wear the
 * pixel frame: ornate corner (mirrored for all four), repeating rail tiles,
 * and a gem medallion centred on every edge run, exactly like the mock.
 *
 * Buttons are the concept's three plate states (9-sliced): unselected steel,
 * gold/blue selected, darker steel while pressed.
 *
 * Nothing here is uiZoom'd: the dock's dvh geometry must match the #game
 * split (CSS zoom rescales viewport units), so sizes are plain px tuned to
 * stay tappable on phones.
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

/** Decorate `box` with the pixel frame: 4 mirrored corners, 4 repeating
 * rails, a gem medallion centred on every edge. Pieces ignore the pointer. */
function dressFrame(box: HTMLElement) {
  for (const c of ["tl", "tr", "bl", "br"]) box.appendChild(mk("i", `ml-fc ml-fc-${c}`));
  for (const e of ["t", "b", "l", "r"]) box.appendChild(mk("i", `ml-fe ml-fe-${e}`));
  for (const g of ["t", "b"]) box.appendChild(mk("i", `ml-fg ml-fg-h ml-fg-${g}`));
  for (const g of ["l", "r"]) box.appendChild(mk("i", `ml-fg ml-fg-v ml-fg-${g}`));
}

/** Frame the game viewport (top 61.8dvh). Pointer-transparent overlay — taps
 * fall through to the Phaser canvas beneath. */
export function mountGameFrame() {
  injectStyles();
  document.getElementById("ml-gameframe")?.remove();
  const f = mk("div", "ml-gameframe");
  f.id = "ml-gameframe";
  dressFrame(f);
  document.body.appendChild(f);
}

export class HudBar {
  private pages = new Map<TabId, HTMLElement>();
  private tabs = new Map<TabId, HTMLButtonElement>();
  private current: TabId = "backpack";

  constructor(private actions: HudActions) {
    injectStyles();
    document.querySelector(".ml-hud")?.remove(); // idempotent across re-joins
    const hud = mk("div", "ml-hud");

    const tabBox = mk("div", "ml-hudbox ml-tabbox");
    dressFrame(tabBox);
    const tabRow = mk("div", "ml-tabrow");
    tabBox.appendChild(tabRow);

    const pageBox = mk("div", "ml-hudbox ml-pagebox");
    dressFrame(pageBox);
    const pageWrap = mk("div", "ml-pages");
    pageBox.appendChild(pageWrap);

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

    hud.append(tabBox, pageBox);
    document.body.appendChild(hud);
    this.select("backpack");
  }

  private select(id: TabId) {
    this.current = id;
    for (const [tid, b] of this.tabs) b.classList.toggle("sel", tid === id);
    for (const [tid, p] of this.pages) p.classList.toggle("show", tid === id);
  }

  private buildPages() {
    // Backpack: a row of empty item slots (the unselected plate doubles as a
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
  // Concept art is displayed at 0.5x: rail band 24→12px, corner 130→65px,
  // gems 48x66→24x33 / 66x48→33x24. Rails start where the corner's arm band
  // sits (both crops begin at the band edge), so a shared inset keeps seams
  // invisible; corners paint after (on top of) the rail runs.
  const css = `
  .ml-hud{position:fixed;left:0;right:0;bottom:0;height:var(--hud-h);z-index:4;background:#05050c;
    display:flex;flex-direction:column;padding:4px 4px 6px;box-sizing:border-box;gap:2px}
  .ml-hudbox{position:relative;box-sizing:border-box}
  .ml-tabbox{flex:none;padding:14px 18px 10px}
  .ml-pagebox{flex:1;min-height:0;padding:16px 14px;margin-top:2px}
  .ml-gameframe{position:fixed;left:0;top:0;right:0;height:var(--hud-h-inv);z-index:3;pointer-events:none}
  /* frame pieces */
  .ml-fc,.ml-fe,.ml-fg{position:absolute;pointer-events:none;image-rendering:pixelated}
  .ml-fc{width:65px;height:65px;background:url(/ui/frame-corner.png);background-size:65px 65px;z-index:2}
  .ml-fc-tl{left:0;top:0}
  .ml-fc-tr{right:0;top:0;transform:scaleX(-1)}
  .ml-fc-bl{left:0;bottom:0;transform:scaleY(-1)}
  .ml-fc-br{right:0;bottom:0;transform:scale(-1,-1)}
  .ml-fe{z-index:1}
  .ml-fe-t,.ml-fe-b{left:30px;right:30px;height:12px;background:url(/ui/frame-rail-h.png) repeat-x;background-size:40px 12px}
  .ml-fe-t{top:0}
  .ml-fe-b{bottom:0;transform:scaleY(-1)}
  .ml-fe-l,.ml-fe-r{top:30px;bottom:30px;width:12px;background:url(/ui/frame-rail-v.png) repeat-y;background-size:12px 40px}
  .ml-fe-l{left:0}
  .ml-fe-r{right:0;transform:scaleX(-1)}
  .ml-fg{z-index:3}
  .ml-fg-h{width:24px;height:33px;left:50%;margin-left:-12px;background:url(/ui/frame-gem-h.png);background-size:24px 33px}
  .ml-fg-t{top:-6px}
  .ml-fg-b{bottom:-6px;transform:scaleY(-1)}
  .ml-fg-v{width:33px;height:24px;top:50%;margin-top:-12px;background:url(/ui/frame-gem-v.png);background-size:33px 24px}
  .ml-fg-l{left:-6px}
  .ml-fg-r{right:-6px;transform:scaleX(-1)}
  /* tab row */
  .ml-tabrow{display:flex;gap:6px;justify-content:center}
  .ml-tab{flex:1;max-width:118px;min-width:0;display:flex;flex-direction:column;align-items:center;gap:1px;
    padding:6px 0 4px;cursor:pointer;image-rendering:pixelated;
    border-style:solid;border-width:9px;border-image:url(/ui/plate-unselected.png) 26 fill / 9px;
    background:none;filter:none}
  .ml-tab:active{border-image:url(/ui/plate-pressed.png) 26 fill / 9px}
  .ml-tab.sel{border-image:url(/ui/plate-selected.png) 32 fill / 10px}
  .ml-tab-icon{height:30px;image-rendering:pixelated;-webkit-user-drag:none}
  .ml-tab-label{font:700 9px/1.1 system-ui,sans-serif;font-size:clamp(7px,2vw,8.5px);
    text-transform:uppercase;
    color:#dfe2ea;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;max-width:100%}
  .ml-tab.sel .ml-tab-label{color:#ffd678}
  /* pages */
  .ml-pages{height:100%;position:relative;overflow:hidden}
  .ml-page{display:none;height:100%;overflow:auto;flex-direction:column;align-items:center;
    justify-content:center;gap:10px;text-align:center}
  .ml-page.show{display:flex}
  .ml-muted{margin:0;font:12px/1.4 system-ui,sans-serif;color:#8f8f9c;text-shadow:0 1px 2px #000}
  .ml-slots{display:flex;gap:8px;justify-content:center}
  .ml-slot{width:40px;height:40px;image-rendering:pixelated;border-style:solid;border-width:9px;
    border-image:url(/ui/plate-pressed.png) 26 fill / 9px;box-sizing:border-box}
  .ml-plate-btn{padding:10px 18px;cursor:pointer;image-rendering:pixelated;background:none;
    border-style:solid;border-width:12px;border-image:url(/ui/plate-unselected.png) 26 fill / 12px;
    font:700 12px system-ui,sans-serif;letter-spacing:.4px;text-transform:uppercase;color:#e8e8ec;
    text-shadow:0 1px 2px #000}
  .ml-plate-btn:active{border-image:url(/ui/plate-pressed.png) 26 fill / 12px;color:#ffd678}
  /* Compact HUD for short viewports (small desktop windows; phones are tall
     and portrait-locked) — everything shrinks so the page keeps usable room. */
  @media (max-height:560px){
    .ml-tabbox{padding:10px 14px 6px}
    .ml-tab{border-width:7px;border-image-width:7px;padding:2px 0}
    .ml-tab-icon{height:18px}
    .ml-pagebox{padding:12px 12px}
    .ml-page{gap:6px}
    .ml-plate-btn{padding:4px 10px;border-width:9px;border-image-width:9px;font-size:10px}
    .ml-slot{width:28px;height:28px;border-width:7px;border-image-width:7px}
    .ml-muted{font-size:10px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

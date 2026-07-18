import { CharacterDef, Manifest } from "./manifest";
import { WorldInfo, DEFAULT_WORLD } from "./maps";
import { showLoading } from "./loading";
import { applyUiZoom } from "./uiscale";
import { dressPlate, repaintPlates } from "./plate";

const NAMES = ["Ari", "Bex", "Cyl", "Dax", "Eir", "Fen", "Gio", "Hana", "Ivo", "Juno", "Kira", "Lio"];

export interface JoinChoice {
  world: string;
  character: CharacterDef;
  name: string;
}

/**
 * Show a pre-join screen: pick a WORLD (any playable maps2 world) + a character
 * + a name. `worlds` empty ⇒ no world picker (demo mode fixes the world);
 * resolves once the player commits, then the caller starts the game.
 */
export function chooseCharacter(manifest: Manifest, worlds: WorldInfo[] = []): Promise<JoinChoice> {
  return new Promise((resolve) => {
    const chars = manifest.characters;
    // Maintainer defaults for fast join-and-iterate: the girl on Demo Lost
    // (the current day-look playground). Fall back to the first entry when
    // either is missing; the 🎲 button still randomizes.
    let selected = Math.max(0, chars.findIndex((c) => c.uid === "default_girl"));
    let selectedWorld = Math.max(0, worlds.findIndex((w) => w.name === "demo_lost"));

    const showWorlds = worlds.length > 0;
    const overlay = el("div", "ml-overlay");
    overlay.innerHTML = `
      <div class="ml-panel">
        <img class="ml-logo" src="/logo.png" alt="Nangijala Online — a browser MMORPG" />
        ${showWorlds ? `
        <div class="ml-dd" id="ml-worlds">
          <button id="ml-dd-head" class="ml-ddhead ml-plated">
            <span id="ml-dd-label"></span>
            <img class="ml-ddchev" src="/ui2/kit-chevron.png" alt="" draggable="false" />
          </button>
          <div class="ml-ddlist" id="ml-dd-list" hidden></div>
        </div>` : ""}
        <div class="ml-grid" id="ml-grid"></div>
        <div class="ml-row">
          <input id="ml-name" class="ml-name" maxlength="24" placeholder="your name"
                 value="${NAMES[Math.floor(Math.random() * NAMES.length)]}" />
          <button id="ml-enter" class="ml-btn ml-plated"><span>Enter world</span></button>
        </div>
      </div>
      <button id="ml-install" class="ml-install ml-plated" hidden><span>Install game</span></button>`;
    document.body.appendChild(overlay);
    applyUiZoom(overlay); // "Desktop site" must not shrink the menu
    injectStyles();
    // No border frame on the select screen (maintainer 2026-07-18: "just use
    // the background without the frame") — the forest art carries the screen
    // alone. The composed vine border (frame2.ts mountSelectFrame +
    // /ui2/select-frame.png) stays available if it's ever wanted back.
    // Android Chrome long-press hit-tests <img>s (thumbnails, portraits) and
    // offers "download image" — suppress at the root, like the HUD does.
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    overlay.querySelectorAll<HTMLElement>(".ml-plated").forEach(pressFx);
    // every select-screen control wears the UI-kit plates (maintainer):
    // held = the dark Down bar, selected = the cream bar, else Normal
    overlay.querySelectorAll<HTMLElement>(".ml-plated").forEach((el) => dressPlate(el, kitKind));
    const nameBox = overlay.querySelector<HTMLElement>("#ml-name");
    if (nameBox) dressPlate(nameBox, () => "slot"); // the empty-slot trough

    // World picker: a DROPDOWN SELECT cut from the UI kit (maintainer
    // 2026-07-18 — "dropdown instead of slider with icons", text only).
    // Anatomy mirrors the kit sheet's dropdown column: the closed header is
    // a kit button bar (same art as the trio — verified identical palette)
    // with the extracted caret overlaid at the shared block scale, and the
    // open list is a stack of option rows (the trio again: normal rows,
    // cream = the selected world, dark while pressed). The old icon
    // carousel is retired — world names render as plain text.
    const worldRows: HTMLElement[] = [];
    if (showWorlds) {
      const head = overlay.querySelector("#ml-dd-head") as HTMLElement;
      const label = overlay.querySelector("#ml-dd-label") as HTMLElement;
      const chev = overlay.querySelector(".ml-ddchev") as HTMLImageElement;
      const list = overlay.querySelector("#ml-dd-list") as HTMLElement;
      // open ⇒ the kit's dark header state (same bar the pressed state
      // uses), with the outline-dark caret the kit paints on it
      dressPlate(head, (e) =>
        e.classList.contains("press") || e.classList.contains("open") ? "down" : "normal",
      );
      pressFx(head);
      const setOpen = (open: boolean) => {
        head.classList.toggle("open", open);
        chev.src = open ? "/ui2/kit-chevron-dark.png" : "/ui2/kit-chevron.png";
        list.hidden = !open;
        // rows were built display:none at 0×0 — compose their plates at
        // the real size the moment they first become visible
        if (open) repaintPlates(list);
      };
      worlds.forEach((w, i) => {
        const row = el("button", "ml-ddrow ml-plated");
        const t = el("span", ""); // span, not a bare text node: the press
        t.textContent = w.label; // rule dips element children only
        row.appendChild(t);
        dressPlate(row, kitKind);
        pressFx(row);
        row.addEventListener("click", () => {
          selectWorld(i);
          setOpen(false);
        });
        list.appendChild(row);
        worldRows.push(row);
      });
      function selectWorld(i: number) {
        selectedWorld = ((i % worlds.length) + worlds.length) % worlds.length;
        worldRows.forEach((r, j) => r.classList.toggle("sel", j === selectedWorld));
        label.textContent = worlds[selectedWorld].label;
      }
      head.addEventListener("click", () => setOpen(list.hidden));
      // tapping anywhere else on the screen folds the list back up
      overlay.addEventListener("pointerdown", (e) => {
        if (!list.hidden && !(e.target as HTMLElement).closest(".ml-dd")) setOpen(false);
      });
      selectWorld(selectedWorld);
    }

    const grid = overlay.querySelector("#ml-grid") as HTMLElement;
    const nameInput = overlay.querySelector("#ml-name") as HTMLInputElement;
    const cells: HTMLElement[] = [];
    const spins: ((on: boolean) => void)[] = [];

    // Different skeletons can reuse the same look prompt, so display names
    // collide (same label, distinct art/uid). Number the repeats so every
    // character reads as unique in the grid.
    const displayNames = disambiguate(chars.map((c) => c.name));

    chars.forEach((c, i) => {
      const label = displayNames[i];
      const cell = el("button", "ml-cell ml-plated");
      pressFx(cell);
      dressPlate(cell, kitKind);
      cell.dataset.index = String(i);
      const preview = spritePreview(c, label, manifest.directions);
      cell.appendChild(preview.img);
      spins.push(preview.setSpin);
      // no text label (maintainer: "the art on the button is enough") —
      // the name stays as the accessible/tooltip name only
      cell.title = label;
      cell.setAttribute("aria-label", label);
      cell.addEventListener("click", () => select(i));
      grid.appendChild(cell);
      cells.push(cell);
    });

    function select(i: number) {
      if (!cells[i]) return; // headless pick() may probe past the roster
      selected = i;
      cells.forEach((c, j) => c.classList.toggle("sel", j === i));
      spins.forEach((s, j) => s(j === i));
      cells[i].scrollIntoView({ block: "nearest" });
    }
    select(selected);

    function commit() {
      const name = (nameInput.value.trim() || NAMES[selected % NAMES.length]).slice(0, 24);
      const world = showWorlds ? worlds[selectedWorld].name : DEFAULT_WORLD;
      // Remember the choice so a dead-connection rejoin (main.ts) can skip
      // this screen and go straight back into the world.
      try {
        localStorage.setItem(
          "ml-last-choice",
          JSON.stringify({ world, characterUid: chars[selected].uid, name }),
        );
      } catch {}
      // Show the loading overlay BEFORE tearing this screen down so slow
      // phones never sit on a black page while the world downloads
      // (WorldScene hides it once the player's avatar is in).
      showLoading();
      overlay.remove();
      resolve({ world, character: chars[selected], name });
    }

    (overlay.querySelector("#ml-enter") as HTMLElement).addEventListener("click", commit);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
    });

    // "Install app" (PWA): shown only when the browser offers an install
    // prompt (main.ts stashes it in __mlInstall) and we're not already
    // running as an installed app.
    const installBtn = overlay.querySelector("#ml-install") as HTMLButtonElement;
    const installed = ["standalone", "fullscreen", "minimal-ui"].some(
      (m) => window.matchMedia?.(`(display-mode: ${m})`).matches,
    );
    const refreshInstall = () => {
      installBtn.hidden = installed || !(window as any).__mlInstall;
    };
    refreshInstall();
    window.addEventListener("ml-can-install", refreshInstall);
    installBtn.addEventListener("click", async () => {
      const prompt = (window as any).__mlInstall;
      if (!prompt) return;
      prompt.prompt();
      const choice = await prompt.userChoice.catch(() => null);
      if (choice?.outcome === "accepted") {
        (window as any).__mlInstall = null;
        refreshInstall();
      }
    });

    // Expose for headless verification.
    (window as any).__mlSelect = {
      count: () => chars.length,
      pick: (i: number) => select(i),
      selected: () => selected,
      worlds: () => worlds.map((w) => w.name),
      pickWorld: (i: number) => worldRows[i]?.click(),
      selectedWorld: () => (showWorlds ? worlds[selectedWorld].name : DEFAULT_WORLD),
      installVisible: () => !installBtn.hidden,
      commit,
    };
  });
}

/**
 * Append " (2)", " (3)", … to names that appear more than once, so repeated
 * look prompts across skeletons don't render as identical grid entries. Names
 * that are already unique are left untouched.
 */
function disambiguate(names: string[]): string[] {
  const total = new Map<string, number>();
  for (const n of names) total.set(n, (total.get(n) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((n) => {
    if ((total.get(n) ?? 0) <= 1) return n;
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return `${n} (${k})`;
  });
}

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** Momentary pressed-plate feedback via pointer events (same pattern as
 * hud.ts): CSS :active is hover-gated because mobile Chrome keeps it sticky
 * on the last tap — .press goes on at finger-down, off the moment the finger
 * lifts or leaves, so it can never stick. */
function pressFx(b: HTMLElement) {
  b.addEventListener("pointerdown", () => b.classList.add("press"));
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    b.addEventListener(ev, () => b.classList.remove("press"));
}

const SPIN_MS = 220; // per 45° rotation step ≈ 1.8s per full revolution

/**
 * Character preview. UNSELECTED characters stand still facing the camera
 * (base/south.png); the SELECTED one pivots through all 8 base rotations in
 * a 360° loop, like a figure on a turntable (the maintainer swapped this in
 * for the old idle-animation preview). Rotations are warmed and the spin
 * only engages once every direction has loaded — a character with missing
 * rotation art (the built-in Wanderer) just stays on its static portrait.
 */
function spritePreview(
  c: CharacterDef,
  label: string,
  directions: string[],
): { img: HTMLElement; setSpin: (on: boolean) => void } {
  // The 112×112 portrait canvas is mostly empty — the figure occupies only
  // ~29×87 px in its centre (measured: x42-71, y10-97) — so the cards read
  // "too big" (maintainer). Show the art 1:1 (native px — the old 128px box
  // was a non-integer 1.14× upscale) through a viewport cropped to the
  // figure; the box is the element the card lays out.
  const box = el("div", "ml-portrait-box");
  const img = el("img", "ml-portrait") as HTMLImageElement;
  box.appendChild(img);
  img.alt = label;
  img.src = c.portrait;
  // Rotations live beside the portrait: <root>/base/<dir>.png.
  let urls: string[] | null = c.portrait.endsWith("/south.png")
    ? directions.map((d) => c.portrait.replace(/south\.png$/, `${d}.png`))
    : null;
  urls?.forEach((u) => {
    const p = new Image();
    p.onerror = () => (urls = null); // any missing rotation disables the spin
    p.src = u;
  });
  let timer: ReturnType<typeof setInterval> | null = null;
  let k = 0;
  const setSpin = (on: boolean) => {
    if (on && urls && timer === null) {
      timer = setInterval(() => {
        if (!urls) return;
        k = (k + 1) % urls.length;
        img.src = urls[k];
      }, SPIN_MS);
    } else if (!on && timer !== null) {
      clearInterval(timer);
      timer = null;
      k = 0;
      img.src = c.portrait;
    }
  };
  return { img: box, setSpin };
}

let stylesInjected = false;
function kitKind(el: HTMLElement): "normal" | "sel" | "down" {
  if (el.classList.contains("press")) return "down";
  if (el.classList.contains("sel")) return "sel";
  return "normal";
}

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  /* In-game-UI theme (maintainer 2026-07-17: "the character-select looks a
     bit old" next to the frame-v2 HUD). Built ONLY from the shipped /ui2
     assets and their palette — the 3-state wooden plates (border-image,
     13px = the sanctioned exact-half scale from the narrow-phone HUD), the
     slot socket as the name trough, the cobblestone page backdrop dimmed
     under a dark wash so the logo still pops, wood #23160d + gold #ffd678.
     Selection = plate-selected (the pre-blended gold-glow art), NOT a CSS
     border — same language as the HUD tabs. NO texture from the maintainer's
     inspiration mock was copied. */
  const css = `
  /* the maintainer's enchanted-forest select background (768x1376, frame
     space): fairies, crystals, glowing mushrooms around a mossy clearing.
     cover + center keeps the clearing on screen at any aspect; a LIGHT navy
     veil keeps the plaques/text readable over the busy art (the old stone
     backdrop wore a heavy .84 wash — this art is meant to be SEEN). */
  /* --ml-col: THE shared column width every row-level control aligns to
     (dropdown, character cards, action row, install). On the overlay, not
     the panel — the install button lives outside the panel now. */
  /* The OVERLAY scrolls, not the panel: an overflow:auto panel clipped the
     logo's drop-shadow glow at its top edge — a hard horizontal line over
     the logo (maintainer). The overlay is viewport-sized, so its clip
     edges are off screen; margin:auto on the panel keeps it centred when
     short AND reachable when tall (flex centering alone would clip the
     top of overflowing content). */
  .ml-overlay{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
    overflow:auto;background:#0d101c;font-family:system-ui,sans-serif;color:#e8e8ec;--ml-col:min(720px,96%)}
  .ml-overlay{background-image:linear-gradient(rgba(13,16,28,.28),rgba(13,16,28,.28)),url(/ui2/select-bg.png);
    background-size:auto,cover;background-position:center;background-repeat:repeat,no-repeat;image-rendering:pixelated}
  /* No vw/vh inside this overlay: it may carry a compensating CSS zoom
     (uiscale.ts) and viewport units would double-count under it. */
  /* Slim side padding: the ring frame provides the visual margin now, and
     the phone needs the width — two 152px character tracks + their gap must
     fit inside ring pads + panel (128px native portraits, never scaled). */
  /* One vertical RHYTHM for the whole column (maintainer: "add some spacing
     to align the UI elements"): the panel is a flex column with a uniform
     gap — logo / world dropdown / characters / action row / install — and
     the dropdown + action row share ONE width (--ml-col) so their edges
     line up. */
  .ml-panel{width:min(920px,100%);margin:auto;padding:16px 8px 12px;text-align:center;
    display:flex;flex-direction:column;align-items:center;gap:20px}
  /* 2x logo (maintainer), with a BLACK GLOW hugging the silhouette:
     drop-shadow follows the png alpha. Strengthened twice on request
     ("can't see the glow", then "more dark/black, bigger glow") — four
     stacked layers: a dense core plus a wide soft halo. */
  .ml-logo{display:block;width:min(840px,96%);margin:0 auto;user-select:none;-webkit-user-drag:none;
    filter:drop-shadow(0 0 10px rgba(0,0,0,.65)) drop-shadow(0 0 28px rgba(0,0,0,.6))
      drop-shadow(0 0 64px rgba(0,0,0,.55)) drop-shadow(0 0 110px rgba(0,0,0,.45))}
  /* UI-KIT plates (plate.ts dressPlate): Normal / cream Selected / dark
     Down — same trio and block scale as the HUD. */
  .ml-plated{border:none;background:none;background-repeat:no-repeat;background-size:100% 100%;
    image-rendering:pixelated;box-sizing:border-box;cursor:pointer;
    touch-action:manipulation;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
  /* WORLD DROPDOWN (the kit's dropdown column, maintainer: "dropdown
     instead of slider with icons", text only). Closed head = a kit bar +
     the extracted caret at the shared block scale; open list = kit option
     rows stacked below (cream = the selected world). The open head wears
     the kit's dark header state (the down bar) like the sheet shows. */
  .ml-dd{position:relative;width:var(--ml-col);z-index:20}
  .ml-ddhead{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:120px;
    color:#fff;font:700 17px system-ui,sans-serif;letter-spacing:.6px;text-transform:uppercase;
    text-shadow:0 1px 0 rgba(0,0,0,.35)}
  .ml-ddhead.press,.ml-ddhead.open{color:#f4e3c2}
  /* the 6x6 caret at 5x = 30px; top/margin centering, NOT translate — the
     plate press rule owns the children's translate channel */
  .ml-ddchev{position:absolute;right:25px;top:50%;margin-top:-15px;width:30px;height:30px;
    image-rendering:pixelated;pointer-events:none;-webkit-user-drag:none}
  .ml-ddlist{position:absolute;top:calc(100% + 6px);left:0;right:0;display:flex;flex-direction:column;
    gap:6px;max-height:520px;overflow-y:auto;overscroll-behavior:contain}
  /* author display:flex would beat the UA's [hidden] rule — restate it */
  .ml-ddlist[hidden]{display:none}
  .ml-ddrow{display:flex;align-items:center;justify-content:center;height:120px;flex:none;
    color:#fff;font:700 17px system-ui,sans-serif;letter-spacing:.6px;text-transform:uppercase;
    text-shadow:0 1px 0 rgba(0,0,0,.35)}
  .ml-ddrow.sel{color:#4a2a1c;text-shadow:none}
  .ml-ddrow.press{color:#f4e3c2}
  /* character cards GROW to the shared column (maintainer: "make the
     character buttons bigger so the UI align with the other UI rows") —
     two per row, edges flush with the dropdown/action row */
  .ml-grid{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;width:var(--ml-col)}
  .ml-cell{flex:1 1 calc(50% - 6px);display:flex;flex-direction:column;align-items:center;justify-content:center;
    padding:6px 10px;box-sizing:border-box}
  .ml-sprite{image-rendering:pixelated;background-repeat:no-repeat;flex:none}
  /* 2x characters in an UNCHANGED box (maintainer: half the 4x size, keep
     the button size — the padding does the breathing): the 112 art at an
     integer 2x = 224, the measured figure (x42-71, y10-97 native; 60x174
     at 2x) centred in the same 192x368 viewport */
  .ml-portrait-box{width:192px;height:368px;overflow:hidden;position:relative;flex:none}
  .ml-portrait{position:absolute;left:-18px;top:77px;width:224px;height:224px;image-rendering:pixelated}
  /* Action row: ONE height (64px, same as the world chips) for the trough,
     the dice and Enter — all buttons the same size, text centered. Wraps on
     narrow screens (inside the ring) so the trough never collapses: the
     Enter CTA drops to its own centred line instead. */
  .ml-row{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;align-items:center;width:var(--ml-col)}
  /* Name input = the kit's empty-slot trough (dressPlate "slot"); it FILLS
     the row's leftover width so the action row spans exactly --ml-col and
     its edges line up with the dropdown above. */
  .ml-name{flex:1 1 170px;min-width:170px;height:120px;padding:0 18px;border:none;
    image-rendering:pixelated;box-sizing:border-box;background:none;background-repeat:no-repeat;
    background-size:100% 100%;color:#e8e8ec;font-size:18px;text-align:center;text-shadow:0 1px 2px #000}
  .ml-name:focus{outline:none;color:#ffd678}
  /* ENTER WORLD = a kit button with a REAL label (the plaque art with the
     baked label is retired) */
  .ml-btn{display:flex;align-items:center;justify-content:center;flex:none;border:none;padding:0 20px;
    width:240px;height:120px;image-rendering:pixelated;
    font:700 17px system-ui,sans-serif;letter-spacing:.6px;text-transform:uppercase;color:#fff;
    text-shadow:0 1px 0 rgba(0,0,0,.35)}
  .ml-btn.press{color:#f4e3c2}
  /* install prompt: PINNED to the screen bottom (maintainer), full column
     width, clear of the version badge. Outside the panel, so the panel's
     overflow scroll can't clip or move it. Label styled EXACTLY like the
     Enter world button (maintainer: "INSTALL GAME", same font). */
  .ml-install{position:fixed;bottom:44px;left:50%;transform:translateX(-50%);z-index:2;
    border:none;padding:0 24px;width:var(--ml-col);height:120px;
    image-rendering:pixelated;cursor:pointer;
    font:700 17px system-ui,sans-serif;letter-spacing:.6px;text-transform:uppercase;color:#fff;
    display:inline-flex;align-items:center;justify-content:center;text-shadow:0 1px 0 rgba(0,0,0,.35)}
  .ml-install.press{color:#f4e3c2}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

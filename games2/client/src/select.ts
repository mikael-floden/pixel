import { CharacterDef, Manifest } from "./manifest";
import { WorldInfo, DEFAULT_WORLD } from "./maps";
import { showLoading } from "./loading";
import { applyUiZoom } from "./uiscale";

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
        <p class="ml-sub">${showWorlds ? "Choose a world and a character, then step in." : "Choose your character and step into the shared world."}</p>
        ${showWorlds ? '<div class="ml-section">World</div><div class="ml-worlds" id="ml-worlds"></div><div class="ml-section">Character</div>' : ""}
        <div class="ml-grid" id="ml-grid"></div>
        <div class="ml-row">
          <input id="ml-name" class="ml-name" maxlength="24" placeholder="your name"
                 value="${NAMES[Math.floor(Math.random() * NAMES.length)]}" />
          <button id="ml-random" class="ml-btn ml-ghost ml-plated" title="Random character">🎲</button>
          <button id="ml-enter" class="ml-btn ml-plated">Enter world</button>
        </div>
        <button id="ml-install" class="ml-install ml-plated" hidden>📱 Install as an app on your home screen</button>
      </div>`;
    document.body.appendChild(overlay);
    applyUiZoom(overlay); // "Desktop site" must not shrink the menu
    injectStyles();
    // Android Chrome long-press hit-tests <img>s (thumbnails, portraits) and
    // offers "download image" — suppress at the root, like the HUD does.
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    overlay.querySelectorAll<HTMLElement>(".ml-plated").forEach(pressFx);

    // World picker: one chip per playable world (thumbnail + label).
    const worldChips: HTMLElement[] = [];
    if (showWorlds) {
      const wrap = overlay.querySelector("#ml-worlds") as HTMLElement;
      worlds.forEach((w, i) => {
        const chip = el("button", "ml-world ml-plated");
        pressFx(chip);
        if (w.preview) {
          const img = el("img", "ml-world-img") as HTMLImageElement;
          img.src = `/assets/${w.preview.replace(/^\/+/, "")}`;
          img.alt = w.label;
          chip.appendChild(img);
        }
        const span = el("span", "");
        span.textContent = w.label;
        chip.appendChild(span);
        chip.addEventListener("click", () => selectWorld(i));
        wrap.appendChild(chip);
        worldChips.push(chip);
      });
      function selectWorld(i: number) {
        selectedWorld = i;
        worldChips.forEach((c, j) => c.classList.toggle("sel", j === i));
      }
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
      cell.dataset.index = String(i);
      const preview = spritePreview(c, label, manifest.directions);
      cell.appendChild(preview.img);
      spins.push(preview.setSpin);
      const span = el("span", "");
      span.textContent = label;
      cell.appendChild(span);
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
    (overlay.querySelector("#ml-random") as HTMLElement).addEventListener("click", () =>
      select(Math.floor(Math.random() * chars.length)),
    );
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
      pickWorld: (i: number) => worldChips[i]?.click(),
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
  const img = el("img", "ml-portrait") as HTMLImageElement;
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
  return { img, setSpin };
}

let stylesInjected = false;
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
  .ml-overlay{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
    background:#0b0705 linear-gradient(rgba(11,7,5,.82),rgba(11,7,5,.82));font-family:system-ui,sans-serif;color:#e8e8ec}
  .ml-overlay{background-image:linear-gradient(rgba(11,7,5,.82),rgba(11,7,5,.82)),url(/ui2/stone.png);
    background-size:auto,100% auto;background-repeat:repeat,repeat-y;image-rendering:pixelated}
  /* No vw/vh inside this overlay: it may carry a compensating CSS zoom
     (uiscale.ts) and viewport units would double-count under it. */
  .ml-panel{width:min(720px,96%);max-height:96%;overflow:auto;padding:24px 14px 20px;text-align:center}
  .ml-logo{display:block;width:min(420px,88%);margin:0 auto;user-select:none;-webkit-user-drag:none}
  .ml-sub{margin:6px 0 14px;color:#b8a67f;text-shadow:0 1px 2px #000}
  .ml-section{text-align:left;margin:12px 4px 6px;font:700 12px/1 system-ui,sans-serif;letter-spacing:1.5px;
    text-transform:uppercase;color:#ffd678;text-shadow:0 1px 2px #000}
  /* Wooden plate = the HUD's 3-state border-image at the 13px half scale;
     no border-radius (the art owns the silhouette), backgrounds come from
     the plate fill. Selected uses plate-selected's baked gold glow. */
  .ml-plated{border-style:solid;border-width:13px;border-image:url(/ui2/plate-normal.png) 56 fill / 13px;
    background:none;image-rendering:pixelated;box-sizing:border-box;cursor:pointer;
    touch-action:manipulation;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
  /* No nested scroll boxes: the panel is the ONE scroll context (the
     maintainer's concept is a single scrolling page) — a capped inner box
     silently hid the worlds that didn't fit (Trans Demo, on the phone).
     GRID, not flex-wrap: every chip fills an equal track, so all world
     buttons are the SAME SIZE with centered content (maintainer). */
  .ml-worlds{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;padding:2px}
  .ml-world{display:flex;align-items:center;justify-content:center;gap:8px;height:64px;padding:2px 6px;
    color:#dfe2ea;font-size:13px;text-shadow:0 1px 2px #000}
  .ml-world span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ml-world.sel{border-image:url(/ui2/plate-selected.png) 56 fill / 13px;color:#ffd678}
  .ml-world.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  .ml-world-img{width:34px;height:34px;object-fit:cover;image-rendering:auto;flex:none}
  .ml-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:8px;padding:2px}
  .ml-cell{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 2px;
    color:#dfe2ea;font-size:12px;text-shadow:0 1px 2px #000}
  .ml-cell.sel{border-image:url(/ui2/plate-selected.png) 56 fill / 13px;color:#ffd678}
  .ml-cell.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  .ml-sprite{image-rendering:pixelated;background-repeat:no-repeat;flex:none}
  .ml-portrait{width:128px;height:128px;object-fit:contain;image-rendering:pixelated;margin:4px 0}
  .ml-cell span{max-width:136px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* Action row: ONE height (64px, same as the world chips) for the trough,
     the dice and Enter — all buttons the same size, text centered. */
  .ml-row{display:flex;gap:8px;margin-top:16px;justify-content:center;align-items:center}
  /* Name input = the backpack slot socket (its fill IS the dark trough). */
  .ml-name{flex:1;max-width:280px;min-width:0;height:64px;padding:0 8px;border-style:solid;border-width:20px;
    border-image:url(/ui2/slot.png) 10 fill / 20px;image-rendering:pixelated;box-sizing:border-box;
    background:none;color:#e8e8ec;font-size:16px;text-align:center;text-shadow:0 1px 2px #000}
  .ml-name:focus{outline:none;color:#ffd678}
  .ml-btn{display:flex;align-items:center;justify-content:center;height:64px;padding:0 16px;
    color:#ffd678;font:700 15px system-ui,sans-serif;letter-spacing:.4px;
    text-transform:uppercase;text-shadow:0 1px 2px #000}
  .ml-btn.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  .ml-ghost{color:#e8e8ec;font-size:18px;width:64px;padding:0;text-transform:none;flex:none}
  .ml-install{margin-top:12px;padding:6px 14px;color:#c9c9cf;font-size:13px;text-shadow:0 1px 2px #000;
    display:inline-flex;align-items:center;justify-content:center}
  .ml-install.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  @media (hover:hover){
    .ml-plated:active{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
    .ml-world.sel:active,.ml-cell.sel:active{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

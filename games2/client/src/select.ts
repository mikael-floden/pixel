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
          <button id="ml-random" class="ml-btn ml-ghost" title="Random character">🎲</button>
          <button id="ml-enter" class="ml-btn">Enter world</button>
        </div>
        <button id="ml-install" class="ml-install" hidden>📱 Install as an app on your home screen</button>
      </div>`;
    document.body.appendChild(overlay);
    applyUiZoom(overlay); // "Desktop site" must not shrink the menu
    injectStyles();

    // World picker: one chip per playable world (thumbnail + label).
    const worldChips: HTMLElement[] = [];
    if (showWorlds) {
      const wrap = overlay.querySelector("#ml-worlds") as HTMLElement;
      worlds.forEach((w, i) => {
        const chip = el("button", "ml-world");
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
      const cell = el("button", "ml-cell");
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
  /* Pure-black theme, matching the loading screen. The "panel" is only a
     scroll/layout container — NO background card: the logo (transparent PNG)
     must sit directly on raw #000 (playtester), so the world/character cards
     and inputs alone provide the structure. Neutral near-black greys for
     those (the old blue tint clashed against #000), with the selection gold
     as the ONE accent: borders, the Enter CTA, hovers. */
  const css = `
  .ml-overlay{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
    background:#000;font-family:system-ui,sans-serif;color:#e8e8ec}
  /* No vw/vh inside this overlay: it may carry a compensating CSS zoom
     (uiscale.ts) and viewport units would double-count under it. */
  .ml-panel{width:min(720px,92%);max-height:92%;overflow:auto;padding:28px 28px 20px;text-align:center}
  .ml-logo{display:block;width:min(420px,88%);margin:0 auto;user-select:none;-webkit-user-drag:none}
  .ml-sub{margin:6px 0 16px;color:#8f8f98}
  .ml-section{text-align:left;margin:14px 2px 6px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#7c7c86}
  .ml-worlds{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-start;max-height:190px;overflow:auto;padding:2px}
  .ml-world{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 6px;cursor:pointer;
    background:#151517;border:2px solid #232327;border-radius:10px;color:#c9c9cf;font-size:13px}
  .ml-world:hover{background:#1b1b1e}
  .ml-world-img{width:34px;height:34px;object-fit:cover;image-rendering:auto;border-radius:6px;background:#0a0a0c;flex:none}
  .ml-world.sel{border-color:#ffd678;background:#211c12}
  .ml-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px;
    max-height:340px;overflow:auto;padding:4px}
  .ml-cell{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 6px;cursor:pointer;
    background:#151517;border:2px solid #232327;border-radius:10px;color:#c9c9cf;font-size:12px}
  .ml-cell:hover{background:#1b1b1e}
  .ml-sprite{image-rendering:pixelated;background-repeat:no-repeat;flex:none}
  .ml-portrait{width:128px;height:128px;object-fit:contain;image-rendering:pixelated;margin:6px 0}
  .ml-cell span{max-width:136px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ml-cell.sel{border-color:#ffd678;background:#211c12}
  .ml-row{display:flex;gap:10px;margin-top:20px;justify-content:center;align-items:stretch}
  .ml-name{flex:1;max-width:280px;padding:10px 14px;border-radius:8px;border:1px solid #2c2c31;
    background:#0a0a0c;color:#e8e8ec;font-size:16px}
  .ml-name:focus{outline:none;border-color:#ffd67888}
  .ml-btn{padding:10px 18px;border:none;border-radius:8px;background:#ffd678;color:#1c1300;font-size:15px;
    font-weight:700;cursor:pointer}
  .ml-btn:hover{background:#ffe093}
  .ml-ghost{background:#1c1c1f;color:#e8e8ec;font-size:18px;padding:10px 14px}
  .ml-ghost:hover{background:#242428}
  .ml-install{margin-top:14px;padding:9px 16px;border:1px solid #2c2c31;border-radius:8px;
    background:#151517;color:#c9c9cf;font-size:13px;cursor:pointer}
  .ml-install:hover{background:#1b1b1e}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

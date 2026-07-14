import { CharacterDef, Manifest, frameUrl } from "./manifest";
import { WorldInfo, DEFAULT_WORLD } from "./maps";
import { showLoading } from "./loading";

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
    let selected = Math.floor(Math.random() * chars.length);
    let selectedWorld = 0; // index into `worlds`

    const showWorlds = worlds.length > 0;
    const overlay = el("div", "ml-overlay");
    overlay.innerHTML = `
      <div class="ml-panel">
        <h1 class="ml-title">Nangijala</h1>
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
      selectWorld(0);
    }

    const grid = overlay.querySelector("#ml-grid") as HTMLElement;
    const nameInput = overlay.querySelector("#ml-name") as HTMLInputElement;
    const cells: HTMLElement[] = [];

    // Different skeletons can reuse the same look prompt, so display names
    // collide (same label, distinct art/uid). Number the repeats so every
    // character reads as unique in the grid.
    const displayNames = disambiguate(chars.map((c) => c.name));

    chars.forEach((c, i) => {
      const label = displayNames[i];
      const cell = el("button", "ml-cell");
      cell.dataset.index = String(i);
      cell.appendChild(spritePreview(c, label));
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
      cells[i].scrollIntoView({ block: "nearest" });
    }
    select(selected);

    function commit() {
      const name = (nameInput.value.trim() || NAMES[selected % NAMES.length]).slice(0, 24);
      const world = showWorlds ? worlds[selectedWorld].name : DEFAULT_WORLD;
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

const IDLE_FPS = 6; // matches the in-game idle frame rate (WorldScene ANIM_FPS)

/**
 * A preview showing the character as in game: the idle-south frames cycled at
 * the in-game idle FPS. characters2 stores animations as frame folders, so we
 * swap an <img>'s src per frame. Falls back to the portrait (base/south.png)
 * when there are no idle frames (e.g. the built-in Wanderer).
 */
function spritePreview(c: CharacterDef, label: string): HTMLElement {
  const img = el("img", "ml-portrait") as HTMLImageElement;
  img.alt = label;
  const frames = c.animations.idle?.south ?? 0;
  if (frames > 1) {
    const urls = Array.from({ length: frames }, (_, i) => frameUrl(c, "idle", "south", i));
    urls.forEach((u) => {
      const p = new Image();
      p.src = u; // warm the cache so swaps don't flicker
    });
    let n = 0;
    img.src = urls[0];
    setInterval(() => {
      n = (n + 1) % frames;
      img.src = urls[n];
    }, 1000 / IDLE_FPS);
  } else {
    img.src = c.portrait;
  }
  return img;
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
  .ml-overlay{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle at 50% 30%, #1c2540, #0c0c16);font-family:system-ui,sans-serif;color:#e8e8f0}
  .ml-panel{width:min(720px,92vw);max-height:92vh;overflow:auto;padding:28px;border-radius:14px;
    background:#12121ccc;box-shadow:0 10px 40px #0008;text-align:center}
  .ml-title{margin:0;font-size:44px;letter-spacing:2px;color:#cfe0ff}
  .ml-sub{margin:6px 0 16px;color:#9aa0bf}
  .ml-section{text-align:left;margin:14px 2px 6px;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#8890b3}
  .ml-worlds{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-start;max-height:24vh;overflow:auto;padding:2px}
  .ml-world{display:flex;align-items:center;gap:8px;padding:6px 10px 6px 6px;cursor:pointer;
    background:#1e1e30;border:2px solid transparent;border-radius:10px;color:#c7cbe6;font-size:13px}
  .ml-world-img{width:34px;height:34px;object-fit:cover;image-rendering:auto;border-radius:6px;background:#0f0f1c;flex:none}
  .ml-world.sel{border-color:#ffd678;background:#2a2a44}
  .ml-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px;
    max-height:44vh;overflow:auto;padding:4px}
  .ml-cell{display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 6px;cursor:pointer;
    background:#1e1e30;border:2px solid transparent;border-radius:10px;color:#c7cbe6;font-size:12px}
  .ml-sprite{image-rendering:pixelated;background-repeat:no-repeat;flex:none}
  .ml-portrait{width:72px;height:72px;object-fit:contain;image-rendering:pixelated;margin:28px 0}
  .ml-cell span{max-width:136px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ml-cell.sel{border-color:#ffd678;background:#2a2a44}
  .ml-row{display:flex;gap:10px;margin-top:20px;justify-content:center;align-items:stretch}
  .ml-name{flex:1;max-width:280px;padding:10px 14px;border-radius:8px;border:1px solid #3a3a58;
    background:#0f0f1c;color:#e8e8f0;font-size:16px}
  .ml-btn{padding:10px 18px;border:none;border-radius:8px;background:#5a7bd6;color:#fff;font-size:15px;
    font-weight:600;cursor:pointer}
  .ml-btn:hover{background:#6a8bea}
  .ml-ghost{background:#26263c;font-size:18px;padding:10px 14px}
  .ml-install{margin-top:14px;padding:9px 16px;border:1px solid #3a3a58;border-radius:8px;
    background:#1e1e30;color:#c7cbe6;font-size:13px;cursor:pointer}
  .ml-install:hover{background:#2a2a44}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

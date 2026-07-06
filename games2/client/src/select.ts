import { CharacterDef, Manifest, frameUrl } from "./manifest";

const NAMES = ["Ari", "Bex", "Cyl", "Dax", "Eir", "Fen", "Gio", "Hana", "Ivo", "Juno", "Kira", "Lio"];

export interface JoinChoice {
  character: CharacterDef;
  name: string;
}

/**
 * Show a pre-join screen: pick any generated character + enter a name.
 * Resolves once the player commits, then the caller starts the game.
 */
export function chooseCharacter(manifest: Manifest): Promise<JoinChoice> {
  return new Promise((resolve) => {
    const chars = manifest.characters;
    let selected = Math.floor(Math.random() * chars.length);

    const overlay = el("div", "ml-overlay");
    overlay.innerHTML = `
      <div class="ml-panel">
        <h1 class="ml-title">Nangijala</h1>
        <p class="ml-sub">Choose your character and step into the shared world.</p>
        <div class="ml-grid" id="ml-grid"></div>
        <div class="ml-row">
          <input id="ml-name" class="ml-name" maxlength="24" placeholder="your name"
                 value="${NAMES[Math.floor(Math.random() * NAMES.length)]}" />
          <button id="ml-random" class="ml-btn ml-ghost" title="Random character">🎲</button>
          <button id="ml-enter" class="ml-btn">Enter world</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    injectStyles();

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
      overlay.remove();
      resolve({ character: chars[selected], name });
    }

    (overlay.querySelector("#ml-enter") as HTMLElement).addEventListener("click", commit);
    (overlay.querySelector("#ml-random") as HTMLElement).addEventListener("click", () =>
      select(Math.floor(Math.random() * chars.length)),
    );
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
    });

    // Expose for headless verification.
    (window as any).__mlSelect = {
      count: () => chars.length,
      pick: (i: number) => select(i),
      selected: () => selected,
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
  .ml-sub{margin:6px 0 20px;color:#9aa0bf}
  .ml-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px;
    max-height:52vh;overflow:auto;padding:4px}
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
  .ml-ghost{background:#26263c;font-size:18px;padding:10px 14px}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

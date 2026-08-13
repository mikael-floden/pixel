import { CharacterDef, Manifest } from "./manifest";
import { WorldInfo, DEFAULT_WORLD } from "./maps";
import { showLoading } from "./loading";
import { mountTheme, toggleTheme } from "./theme";
import { openWikiPanel } from "./wikipanel";
import { gameAudio } from "../../composer/index";
import { withV } from "./assetver";
import { drawPixelText, measurePixelText } from "./pixeltext";

const NAMES = ["Ari", "Bex", "Cyl", "Dax", "Eir", "Fen", "Gio", "Hana", "Ivo", "Juno", "Kira", "Lio"];

/**
 * THE TAGLINE POOL. The logo used to carry "A THOUSAND PATHS. ONE LIFE."
 * baked into the artwork; the letters were painted out of `logo.webp` (the
 * banner, its gold and rose rules and both flourishes are untouched) and the
 * line is drawn over the empty plate instead, so it costs nothing to change
 * and never needs the art regenerated — which is the whole point, since every
 * regeneration of that art loses quality.
 *
 * The maintainer chose these twelve from a page of thirty-five: the land as
 * something older and awake, no arrival imagery, no daylight, no cheer.
 * ONE IS PICKED PER TITLE-SCREEN LOAD ("rotate between the survivors, not in
 * realtime, but every time the screen is loaded"), never the same one twice
 * running.
 *
 * ADDING A LINE: keep it inside the plate. The limit is NOT the banner's
 * width — it is the gap between the two FLOURISH ARMS that reach in over the
 * cap rows, measured at x 379..671 in the art, i.e. 293px of clear space.
 * Three of the chosen lines had to be tightened because of it (they read fine
 * in a list and collide with the gold arms on the plate).
 * `scripts/verify-tagline.mjs` measures every entry against that span and
 * fails on one that would not fit, so this list cannot quietly overflow.
 */
export const TAGLINES = [
  "THE LAND ON THE OTHER SIDE.",
  "NO ONE ARRIVES BY ACCIDENT.",
  "WANDER FAR. HOME BY DARK.",
  "SOMETHING OUT THERE WAKES.",
  "THE WILDS REMEMBER YOU.",
  "EVERY FIRE HAS A STORY.",
  "THE DARK IS NOT EMPTY.",
  "THE LAND WAS HERE FIRST.",
  "SOME PATHS DO NOT RETURN.",
  "THE NIGHT KNOWS YOUR NAME.",
  "NO MAP SHOWS EVERYTHING.",
  "WHERE ONLY OLD ROADS EXIST.",
];

/**
 * Where the line sits, in the LOGO ART's own pixels (the file is 1091x634).
 * The cap box is the 14 rows the baked tagline occupied, centred on the gold
 * rule's span (x 349..700) rather than on the image — the banner is not
 * centred in the artwork, and centring on the image put the words 21px off.
 */
const PLATE = { imgW: 1091, imgH: 634, centreX: (349 + 700) / 2, capTop: 557, capRows: 14 };

/**
 * Widest line the plate takes, in font cells. The flourish arms leave 293
 * art-px clear over the cap rows; at 2px per cell that is 146, and 142 keeps
 * 4px of air on each side so a letter never kisses the gold.
 */
export const TAGLINE_MAX_CELLS = 142;

/** The line for THIS load: random, but never a repeat of the last one. */
export function pickTagline(pool: readonly string[] = TAGLINES): string {
  let last = "";
  try {
    last = localStorage.getItem("ml-tagline") || "";
  } catch {}
  const fresh = pool.filter((t) => t !== last);
  const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
  try {
    localStorage.setItem("ml-tagline", pick);
  } catch {}
  return pick;
}

/**
 * Draw one line onto the logo's empty banner. The canvas is laid out in
 * PERCENT of the logo box, so it tracks the art at every width with no resize
 * listener, and its backing store is the artwork's own 2px-per-cell grid —
 * the browser then scales it down exactly as it scales the logo beside it.
 */
export function mountTagline(cv: HTMLCanvasElement, text = pickTagline()): string {
  const art = drawPixelText(text, { scale: 2 });
  const ctx = cv.getContext("2d");
  cv.width = art.width;
  cv.height = art.height;
  if (ctx) ctx.drawImage(art, 0, 0);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  // drawPixelText pads 1px for the shoulder ring — pull that back out so the
  // cap lands on the same rows the baked letters used.
  cv.style.left = pct(PLATE.centreX - art.width / 2, PLATE.imgW);
  cv.style.top = pct(PLATE.capTop - (art.height - PLATE.capRows) / 2, PLATE.imgH);
  cv.style.width = pct(art.width, PLATE.imgW);
  cv.style.height = pct(art.height, PLATE.imgH);
  return text;
}

/** QA: the pool, its measured widths, and the line currently on screen. */
export function taglineInfo() {
  const cv = document.querySelector<HTMLCanvasElement>(".ml-tagline");
  return {
    pool: TAGLINES.map((t) => ({ text: t, cells: measurePixelText(t) })),
    max: TAGLINE_MAX_CELLS,
    shown: cv ? { w: cv.width, h: cv.height, css: cv.getBoundingClientRect() } : null,
  };
}

export interface JoinChoice {
  world: string;
  character: CharacterDef;
  name: string;
}

/**
 * Show a pre-join screen: pick a WORLD (any playable maps2 world) + a character
 * + a name. `worlds` empty ⇒ no world picker (demo mode fixes the world);
 * resolves once the player commits, then the caller starts the game.
 *
 * WIKI-STYLE (maintainer 2026-07-30): the UI-kit plates are gone — the
 * controls are clean wiki cards/inputs/buttons (theme.ts tokens, dark mode
 * shared with the wiki). The maintainer's enchanted-forest backdrop + logo
 * and the title-veil entrance stay: they are brand art, not UI kit.
 */
export function chooseCharacter(manifest: Manifest, worlds: WorldInfo[] = []): Promise<JoinChoice> {
  return new Promise((resolve) => {
    const chars = manifest.characters;
    const showWorlds = worlds.length > 0;

    // PRESELECT the player's last map + character (localStorage ml-last-choice,
    // written on every commit, read by the dead-connection rejoin in main.ts).
    // Stale stored world/character → drop the record, fall back to defaults.
    const stored = readLastChoice();
    const storedCharIdx =
      stored?.characterUid != null ? chars.findIndex((c) => c.uid === stored.characterUid) : -1;
    const storedWorldIdx =
      stored?.world != null ? worlds.findIndex((w) => w.name === stored.world) : -1;
    const staleChar = stored?.characterUid != null && storedCharIdx < 0;
    const staleWorld = showWorlds && stored?.world != null && storedWorldIdx < 0;
    if (stored && (staleChar || staleWorld)) {
      try {
        localStorage.removeItem("ml-last-choice");
      } catch {}
    }
    let selected =
      storedCharIdx >= 0 ? storedCharIdx : Math.max(0, chars.findIndex((c) => c.uid === "default_girl"));
    let selectedWorld =
      storedWorldIdx >= 0 ? storedWorldIdx : Math.max(0, worlds.findIndex((w) => w.name === DEFAULT_WORLD));
    mountTheme(); // wiki tokens + shared dark mode, before any styled DOM
    const overlay = el("div", "ml-overlay");
    overlay.innerHTML = `
      <div class="ml-panel">
        <div class="ml-logowrap">
          <img class="ml-logo" src="${withV("/logo.webp")}" alt="Nangijala Online — a browser MMORPG" />
          <canvas class="ml-tagline" aria-hidden="true"></canvas>
        </div>
        <div class="ml-card">
          ${showWorlds ? `
          <div class="ml-dd" id="ml-worlds">
            <button id="ml-dd-head" class="ml-ddhead" type="button">
              <span id="ml-dd-label"></span>
              <span class="ml-ddchev" aria-hidden="true">▾</span>
            </button>
            <div class="ml-ddlist" id="ml-dd-list" hidden></div>
          </div>` : ""}
          <div class="ml-grid" id="ml-grid"></div>
          <input id="ml-name" class="ml-name" maxlength="24" placeholder="your name"
                 value="${NAMES[Math.floor(Math.random() * NAMES.length)]}" />
        </div>
      </div>
      <button id="ml-enter" class="ml-btn" type="button"><span>Enter world</span></button>
      <button id="ml-install" class="ml-corner ml-install" hidden type="button"
        title="Install game" aria-label="Install game">⤓ Install</button>
      <button id="ml-wiki" class="ml-corner ml-wiki" type="button"
         title="Game wiki — all monsters, characters, tiles, sounds &amp; tuning"><span
         class="ml-cicon">&#128214;</span>Wiki</button>
      <button id="ml-theme-btn" class="ml-corner ml-theme" type="button"
         title="Switch light/dark — one theme for the game and the wiki"><span
         class="ml-cicon">&#127767;</span>Theme</button>`;
    document.body.appendChild(overlay);
    // Arm the title theme the moment the screen mounts — NOT only on a button
    // press (maintainer 2026-07-19). Browser autoplay still needs one gesture,
    // but ANY first tap (anywhere) unlocks the context and the theme comes in.
    gameAudio.startTitleTheme();
    injectStyles();
    // ── TITLE SCREEN → SELECT (maintainer 2026-07-19) ───────────────────
    // The select overlay opens behind a solid-black VEIL with ONLY the logo
    // showing (logo z 101, above the veil). FIRST LAUNCH: the logo emerges on
    // black at the loading-screen placement and AUTO-advances after a short
    // hold; the veil lifts while the logo translates up to its select spot.
    // FROM THE GAME (logout → reload; ml-from-game): no title beat — the
    // screen just fades in from black. A real tap still advances early (and
    // unlocks WebAudio). commit()/__mlSelect bypass all of this.
    const fromGame = (() => {
      try {
        const f = sessionStorage.getItem("ml-from-game") === "1";
        sessionStorage.removeItem("ml-from-game");
        return f;
      } catch {
        return false;
      }
    })();
    const veil = el("div", "ml-title-veil");
    overlay.appendChild(veil);
    const logoImg = overlay.querySelector<HTMLImageElement>(".ml-logo")!;
    // The title beat moves the LOGO GROUP — the art and the tagline drawn over
    // it — so the words can never slide off the banner mid-animation.
    const logo = overlay.querySelector<HTMLElement>(".ml-logowrap")!;
    logo.style.opacity = "0";
    mountTagline(overlay.querySelector<HTMLCanvasElement>(".ml-tagline")!);
    const bgImg = new Image();
    bgImg.src = withV("/ui2/select-bg.webp");
    const decode = (im?: HTMLImageElement) => (im ? im.decode().catch(() => {}) : Promise.resolve());
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const twoFrames = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      gameAudio.startTitleTheme(); // a real tap here unlocks WebAudio + music
      veil.style.pointerEvents = "none";
      Promise.race([decode(bgImg), delay(450)]).then(() =>
        twoFrames(() => {
          logo.style.transition = "transform .8s cubic-bezier(.22,.61,.36,1), opacity .6s ease";
          logo.style.transform = "translateY(0)";
          logo.style.opacity = "1";
          veil.style.opacity = "0";
          setTimeout(() => veil.remove(), 800);
        }),
      );
    };
    veil.addEventListener("pointerdown", reveal);

    if (fromGame) {
      decode(logoImg).then(() => delay(150).then(reveal));
    } else {
      decode(logoImg).then(() => {
        const r = logo.getBoundingClientRect();
        const shift = Math.round(0.45 * window.innerHeight - (r.top + r.height / 2));
        if (r.height >= 10 && shift > 8) {
          logo.style.transition = "none";
          logo.style.transform = `translateY(${shift}px)`;
          logo.getBoundingClientRect(); // commit the balanced start position
        }
        twoFrames(() => {
          logo.style.transition = "opacity .5s ease";
          logo.style.opacity = "1"; // the logo emerges alone on black
          delay(1000).then(reveal); // auto-advance after a short title hold
        });
      });
    }
    // Android Chrome long-press hit-tests <img>s (thumbnails, portraits) and
    // offers "download image" — suppress at the root, like the HUD does.
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());

    // World picker: a clean wiki dropdown (same open/close + .sel mechanics
    // as the kit era; the ids survive for the QA gates).
    const worldRows: HTMLElement[] = [];
    if (showWorlds) {
      const head = overlay.querySelector("#ml-dd-head") as HTMLElement;
      const label = overlay.querySelector("#ml-dd-label") as HTMLElement;
      const list = overlay.querySelector("#ml-dd-list") as HTMLElement;
      pressFx(head);
      const setOpen = (open: boolean) => {
        head.classList.toggle("open", open);
        list.hidden = !open;
      };
      worlds.forEach((w, i) => {
        const row = el("button", "ml-ddrow");
        (row as HTMLButtonElement).type = "button";
        const t = el("span", "");
        t.textContent = w.label;
        row.appendChild(t);
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
      // `!!`: lib.dom now types HTMLElement.hidden as string | boolean (for
      // hidden="until-found"). We only ever assign a boolean below.
      head.addEventListener("click", () => setOpen(!!list.hidden));
      // tapping anywhere else on the screen folds the list back up
      overlay.addEventListener("pointerdown", (e) => {
        if (!list.hidden && !(e.target as HTMLElement).closest(".ml-dd")) setOpen(false);
      });
      selectWorld(selectedWorld);
    }

    const grid = overlay.querySelector("#ml-grid") as HTMLElement;
    const nameInput = overlay.querySelector("#ml-name") as HTMLInputElement;
    // Restore the last-used name too (part of the same remembered choice).
    if (stored?.name && stored.name.trim()) nameInput.value = stored.name.slice(0, 24);
    const cells: HTMLElement[] = [];
    const spins: ((on: boolean) => void)[] = [];

    // Different skeletons can reuse the same look prompt, so display names
    // collide — number the repeats so every character reads as unique.
    const displayNames = disambiguate(chars.map((c) => c.name));

    chars.forEach((c, i) => {
      const label = displayNames[i];
      const cell = el("button", "ml-cell");
      (cell as HTMLButtonElement).type = "button";
      pressFx(cell);
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
      // The loading overlay's black FADES IN over this screen — keep the
      // select mounted beneath it until the black is opaque, then drop it.
      showLoading();
      setTimeout(() => overlay.remove(), 500);
      resolve({ world, character: chars[selected], name });
    }

    const enterBtn = overlay.querySelector("#ml-enter") as HTMLElement;
    pressFx(enterBtn);
    enterBtn.addEventListener("click", commit);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
    });

    // "Install app" (PWA): shown only when the browser offers an install
    // prompt (main.ts stashes it in __mlInstall) and we're not already
    // running as an installed app.
    const installBtn = overlay.querySelector("#ml-install") as HTMLButtonElement;
    pressFx(installBtn);
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

    // The in-game wiki (wiki agent): opens the LEFT DRAWER over this screen —
    // never a browser tab (maintainer 2026-07-30).
    const wikiBtn = overlay.querySelector("#ml-wiki") as HTMLButtonElement;
    pressFx(wikiBtn);
    wikiBtn.addEventListener("click", () => openWikiPanel());

    // Dark/light directly from the select screen (maintainer 2026-07-30) —
    // the SAME shared theme the game HUD and the wiki read (theme.ts), so
    // one press restyles all three, including an open wiki drawer.
    const themeBtn = overlay.querySelector("#ml-theme-btn") as HTMLButtonElement;
    pressFx(themeBtn);
    themeBtn.addEventListener("click", () => toggleTheme());

    // Expose for headless verification.
    (window as any).__mlSelect = {
      count: () => chars.length,
      pick: (i: number) => select(i),
      selected: () => selected,
      worlds: () => worlds.map((w) => w.name),
      pickWorld: (i: number) => worldRows[i]?.click(),
      selectedWorld: () => (showWorlds ? worlds[selectedWorld].name : DEFAULT_WORLD),
      installVisible: () => !installBtn.hidden,
      wikiHref: () => wikiBtn.getAttribute("href"),
      tagline: taglineInfo,
      /** QA: force a specific line onto the plate (no argument = re-pick). */
      setTagline: (t?: string) =>
        mountTagline(overlay.querySelector<HTMLCanvasElement>(".ml-tagline")!, t ?? pickTagline()),
      commit,
    };
  });
}

/**
 * Append " (2)", " (3)", … to names that appear more than once, so repeated
 * look prompts across skeletons don't render as identical grid entries.
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

interface LastChoice {
  world?: string;
  characterUid?: string;
  name?: string;
}
/** Read the persisted last map/character/name (localStorage ml-last-choice,
 * written by commit() and read by the rejoin fast path in main.ts). Never
 * throws — a missing or corrupt value returns null. */
function readLastChoice(): LastChoice | null {
  try {
    const v = JSON.parse(localStorage.getItem("ml-last-choice") || "null");
    return v && typeof v === "object" ? (v as LastChoice) : null;
  } catch {
    return null;
  }
}

/** Momentary pressed feedback via pointer events (same pattern as hud.ts):
 * CSS :active is hover-gated and sticky on mobile Chrome — .press goes on at
 * finger-down, off the moment the finger lifts or leaves. Also the tactile
 * down/up sounds + the WebAudio unlock (the select screen is the FIRST thing
 * the player touches). */
function pressFx(b: HTMLElement) {
  let down = false;
  b.addEventListener("pointerdown", () => {
    down = true;
    b.classList.add("press");
    gameAudio.event("ui.press");
    gameAudio.startTitleTheme();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"])
    b.addEventListener(ev, () => {
      if (down) gameAudio.event("ui.release");
      down = false;
      b.classList.remove("press");
    });
}

const SPIN_MS = 220; // per 45° rotation step ≈ 1.8s per full revolution

/**
 * Character preview. UNSELECTED characters stand still facing the camera
 * (base/south.png); the SELECTED one pivots through all 8 base rotations in
 * a 360° loop. Rotations are warmed and the spin only engages once every
 * direction has loaded — a character with missing rotation art just stays on
 * its static portrait.
 */
function spritePreview(
  c: CharacterDef,
  label: string,
  directions: string[],
): { img: HTMLElement; setSpin: (on: boolean) => void } {
  // The 112×112 portrait canvas is mostly empty — the figure occupies only
  // ~29×87 px in its centre (measured: x42-71, y10-97). Show the art at an
  // integer 2x through a viewport cropped to the figure.
  const box = el("div", "ml-portrait-box");
  const img = el("img", "ml-portrait") as HTMLImageElement;
  box.appendChild(img);
  img.alt = label;
  img.src = c.portrait;
  // Rotations live beside the portrait: <root>/base/<dir>.<ext>. Keep the
  // portrait's OWN extension — the manifest resolves it from disk, so this
  // follows characters2 through the PNG->WebP migration without an edit here.
  const rot = /\/south\.(png|webp)$/.exec(c.portrait);
  let urls: string[] | null = rot
    ? directions.map((d) => c.portrait.replace(/south\.(png|webp)$/, `${d}.${rot[1]}`))
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

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  /* WIKI-STYLE select: the maintainer's enchanted-forest art + logo carry the
     screen; every CONTROL is a clean wiki card on the shared theme tokens.
     Plain responsive CSS — no zoom compensation (like the wiki itself). */
  const css = `
  /* ONE shared control width (maintainer 2026-07-30: the card's edges must
     ALIGN with ENTER WORLD, and the button gets a tiny bit smaller). vw keeps
     both on the SAME reference — %-widths resolved against different
     containing blocks for the fixed button vs the flex panel and drifted. */
  .ml-overlay{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
    overflow:auto;background:#0d101c;font:14px/1.45 var(--sans);color:var(--ink);
    --selw:min(400px, 100vw - 56px)}
  .ml-overlay{background-image:linear-gradient(rgba(13,16,28,.28),rgba(13,16,28,.28)),url(${withV("/ui2/select-bg.webp")});
    background-size:auto,cover;background-position:center;background-repeat:repeat,no-repeat;image-rendering:pixelated}
  .ml-panel{width:var(--selw);margin:auto;padding:12px 0 132px;text-align:center;
    display:flex;flex-direction:column;align-items:center;gap:14px}
  /* the maintainer's logo with its black silhouette glow — brand art, kept.
     The WRAPPER owns the size, the stacking and the title animation so the
     tagline canvas over the banner travels with the art. */
  .ml-logowrap{position:relative;display:block;width:min(360px,92%);margin:0 auto;
    z-index:101;will-change:transform,opacity;pointer-events:none;
    filter:drop-shadow(0 0 8px rgba(0,0,0,.65)) drop-shadow(0 0 22px rgba(0,0,0,.6))
      drop-shadow(0 0 48px rgba(0,0,0,.5))}
  .ml-logo{display:block;width:100%;user-select:none;-webkit-user-drag:none}
  /* The tagline. Placed in PERCENT of the logo box, so it tracks the art at
     every width, and left SMOOTH on purpose (image-rendering:auto): it is
     drawn at the artwork's own 2px-per-cell grid and scaled DOWN with it —
     pixelated here would drop rows out of a 7-row cap. See pixeltext.ts. */
  .ml-tagline{position:absolute;pointer-events:none;image-rendering:auto}
  /* TITLE veil: a solid-black cover; only the logo (z 101) pokes through. */
  .ml-title-veil{position:absolute;inset:0;z-index:100;background:#05070d;opacity:1;
    transition:opacity .7s ease;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  /* ONE wiki card carries the controls: dropdown / characters / name */
  .ml-card{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;
    background:var(--surface);border:1px solid var(--border);border-radius:14px;
    box-shadow:var(--shadow);padding:14px}
  /* ── world dropdown ── */
  .ml-dd{position:relative;width:100%;z-index:20}
  .ml-ddhead{display:flex;align-items:center;justify-content:space-between;gap:8px;
    width:100%;min-height:44px;padding:8px 12px;cursor:pointer;
    background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:10px;
    font:600 14px/1.3 var(--sans);
    touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  .ml-ddhead:hover{background:var(--surface-2)}
  .ml-ddhead.press{transform:translateY(1px);background:var(--surface-2)}
  .ml-ddhead.open{border-color:var(--accent)}
  .ml-ddchev{color:var(--muted);transition:transform .15s ease}
  .ml-ddhead.open .ml-ddchev{transform:rotate(180deg)}
  .ml-ddlist{position:absolute;top:calc(100% + 6px);left:0;right:0;display:flex;flex-direction:column;
    gap:2px;max-height:300px;overflow-y:auto;overscroll-behavior:contain;padding:6px;
    background:var(--surface);border:1px solid var(--border-strong);border-radius:12px;
    box-shadow:var(--shadow);z-index:30}
  .ml-ddlist[hidden]{display:none}
  .ml-ddrow{display:flex;align-items:center;justify-content:flex-start;min-height:40px;flex:none;
    padding:6px 10px;cursor:pointer;background:transparent;color:var(--ink);
    border:none;border-radius:8px;font:500 14px/1.3 var(--sans);text-align:left;
    touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  .ml-ddrow:hover{background:var(--surface-2)}
  .ml-ddrow.press{background:var(--surface-2)}
  .ml-ddrow.sel{background:var(--accent-soft);font-weight:700}
  /* ── character cards: male/female preview ── */
  .ml-grid{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;width:100%}
  .ml-cell{flex:1 1 calc(50% - 5px);min-width:130px;display:flex;flex-direction:column;
    align-items:center;justify-content:center;padding:8px;cursor:pointer;
    background:repeating-conic-gradient(var(--checker-a) 0% 25%, var(--checker-b) 0% 50%) 0 0 / 16px 16px;
    border:1px solid var(--border);border-radius:12px;
    touch-action:manipulation;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
  .ml-cell:hover{border-color:var(--border-strong)}
  .ml-cell.press{transform:translateY(1px)}
  .ml-cell.sel{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
  /* the figure crop: 112² art at an integer 2x, viewport tight on the body
     (figure x42-71, y10-97 native → x84-142, y20-194 at 2x) */
  .ml-portrait-box{width:120px;height:190px;overflow:hidden;position:relative;flex:none}
  /* SETTLED AT 2x (maintainer 2026-07-31: "I take that back and want them 2x
     again. Looked better before"). A 1x round shipped in between and was
     withdrawn — don't re-propose shrinking it. The 2x is INTEGER, so the
     pixel grid stays exact; the box crops the empty margins of the source,
     which is what makes the figure fill it. */
  .ml-portrait{position:absolute;left:-53px;top:-12px;width:224px;height:224px;image-rendering:pixelated}
  /* ── name input ── */
  .ml-name{width:100%;min-height:44px;padding:8px 12px;text-align:center;
    background:var(--surface);color:var(--ink);border:1px solid var(--border);border-radius:10px;
    font:600 15px/1.3 var(--sans);outline:none;box-sizing:border-box}
  .ml-name:focus{border-color:var(--accent)}
  .ml-name::placeholder{color:var(--muted)}
  /* ── ENTER WORLD: the primary action, pinned above the version badge ── */
  .ml-btn{position:fixed;bottom:64px;left:50%;transform:translateX(-50%);z-index:2;
    display:flex;align-items:center;justify-content:center;width:var(--selw);min-height:50px;
    background:var(--accent);color:#fff;border:none;border-radius:12px;cursor:pointer;
    font:700 15px/1 var(--sans);letter-spacing:.06em;text-transform:uppercase;
    box-shadow:var(--shadow);touch-action:manipulation;-webkit-tap-highlight-color:transparent}
  .ml-btn:hover{filter:brightness(1.06)}
  .ml-btn.press{transform:translateX(-50%) translateY(1px);filter:brightness(.97)}
  /* ── corner ghost buttons: Wiki (left), Install (right) ── */
  .ml-corner{position:fixed;top:12px;z-index:2;padding:7px 12px;cursor:pointer;
    background:color-mix(in srgb, var(--surface) 82%, transparent);color:var(--ink);
    border:1px solid var(--border);border-radius:9px;font:600 13px/1 var(--sans);
    backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
    touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none}
  .ml-corner:hover{background:var(--surface-2)}
  .ml-corner.press{transform:translateY(1px)}
  /* The left-hand pair (Wiki over Theme) reads a step bigger than the utility
     Install chip, and the two are sized TOGETHER so they can never drift apart
     (maintainer 2026-07-30: the Theme button must match the Wiki button).
     min-width equalises the boxes despite the different word lengths — stacked
     in a column, a matched pair reads deliberate. */
  .ml-wiki,.ml-theme{left:12px;padding:10px 16px;font-size:15px;border-radius:11px;
    min-width:118px;display:flex;align-items:center;justify-content:flex-start;gap:8px}
  /* Both leading glyphs are EMOJI in a fixed box, so the pair can't differ in
     size or baseline (maintainer 2026-07-30: "the icon has different size and
     is not aligned") — the old ◐ was a thin TEXT glyph next to a colour emoji,
     which no font pairing renders alike. */
  .ml-cicon{flex:none;width:19px;height:19px;font-size:16px;line-height:19px;
    text-align:center;font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif}
  .ml-theme{top:62px}
  .ml-install{right:12px}
  .ml-install[hidden]{display:none}`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

import { CharacterDef, Manifest } from "./manifest";
import { WorldInfo, DEFAULT_WORLD } from "./maps";
import { showLoading } from "./loading";
import { applyUiZoom } from "./uiscale";
import { mountSelectFrame } from "./frame2";

const NAMES = ["Ari", "Bex", "Cyl", "Dax", "Eir", "Fen", "Gio", "Hana", "Ivo", "Juno", "Kira", "Lio"];

// Worlds with an icon from the maintainer's World Selection Atlas
// (ui2/select3/icon-<name>.png, extracted by scripts/extract-world-icons.mjs).
// A world without one (a future maps2 addition) falls back to the wooden
// plate + minimap chip until the atlas gains its icon.
const WORLD_ICONS = new Set([
  "ring_test", "demo_isle", "demo_lost", "glow_test",
  "occlusion_test", "prop_demo", "trans_demo",
]);

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
    // The in-game border ring around the whole select screen (its own asset
    // copy — see frame2.ts / build-select-frame.mjs). Sets the overlay's
    // padding so everything stays inside the ring.
    mountSelectFrame(overlay);
    // Android Chrome long-press hit-tests <img>s (thumbnails, portraits) and
    // offers "download image" — suppress at the root, like the HUD does.
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    overlay.querySelectorAll<HTMLElement>(".ml-plated").forEach(pressFx);

    // World picker: a SWIPE CAROUSEL, not a button grid (maintainer: the
    // grid ate screen space and the picker is a game-under-development
    // feature anyway). The selected world sits CENTRED, the strip LOOPS
    // around, and the neighbours peek in from the edges as a hint of what
    // a swipe brings. Chips are absolutely positioned by signed circular
    // distance from the selection; a swipe drags the whole strip live and
    // snaps on release; clicking a peeked neighbour selects it directly
    // (which is also what the headless pickWorld(i) hook drives).
    const worldChips: HTMLElement[] = [];
    if (showWorlds) {
      const wrap = overlay.querySelector("#ml-worlds") as HTMLElement;
      const n = worlds.length;
      // Chips take their NATURAL width (maintainer: in a slide the buttons
      // no longer have to share one size) — the layout measures each chip
      // and spaces adjacent ones an equal GAP apart.
      const GAP = 8;
      const FLICK = 44; // px of drag that still advances one step
      let dragDx = 0;
      let swallowClick = false; // a real swipe must not click-select a chip
      const prevD = new Map<HTMLElement, number>();
      worlds.forEach((w, i) => {
        // Worlds with an ATLAS ICON (the maintainer's World Selection Atlas
        // sheet) render as a square icon tile + label; the rest keep the
        // wooden plate + minimap fallback.
        const hasIcon = WORLD_ICONS.has(w.name);
        const chip = el("button", hasIcon ? "ml-world ml-wicon" : "ml-world ml-plated");
        pressFx(chip);
        if (hasIcon) {
          const tile = el("div", "ml-wicon-img");
          tile.style.backgroundImage = `url(/ui2/select3/icon-${w.name}.png)`;
          chip.appendChild(tile);
        } else if (w.preview) {
          const img = el("img", "ml-world-img") as HTMLImageElement;
          img.src = `/assets/${w.preview.replace(/^\/+/, "")}`;
          img.alt = w.label;
          img.draggable = false; // native image drag would hijack the swipe
          chip.appendChild(img);
        }
        const span = el("span", "");
        span.textContent = w.label;
        chip.appendChild(span);
        chip.addEventListener("click", () => {
          if (!swallowClick) selectWorld(i);
        });
        wrap.appendChild(chip);
        worldChips.push(chip);
      });
      // Position every chip around the centre. d is the signed circular
      // distance ((-n/2, n/2]), so the strip loops; a chip whose d JUMPS
      // across the wrap (|Δd| > 1) teleports without transition — it's
      // off-screen on both ends, and animating it would streak it across
      // the visible middle. Offsets accumulate the MEASURED widths of the
      // chips between a chip and the centre (equal gaps, unequal chips).
      const mod = (i: number) => ((i % n) + n) % n;
      const chipXs = (): number[] => {
        const xs = new Array<number>(n).fill(0);
        const wOf = (i: number) => worldChips[mod(i)].offsetWidth;
        const right = Math.floor(n / 2); // d range is (-n/2, n/2]
        let x = 0;
        for (let k = 1; k <= right; k++) {
          x += wOf(selectedWorld + k - 1) / 2 + GAP + wOf(selectedWorld + k) / 2;
          xs[mod(selectedWorld + k)] = x;
        }
        x = 0;
        for (let k = 1; k <= n - 1 - right; k++) {
          x -= wOf(selectedWorld - k + 1) / 2 + GAP + wOf(selectedWorld - k) / 2;
          xs[mod(selectedWorld - k)] = x;
        }
        return xs;
      };
      const layout = (animate: boolean) => {
        const xs = chipXs();
        worldChips.forEach((chip, i) => {
          let d = (((i - selectedWorld) % n) + n) % n;
          if (d > n / 2) d -= n;
          const wrapped = Math.abs(d - (prevD.get(chip) ?? d)) > 1.5;
          prevD.set(chip, d);
          chip.classList.toggle("anim", animate && !wrapped);
          chip.style.transform = `translateX(calc(-50% + ${Math.round(xs[i] + dragDx)}px))`;
        });
      };
      function selectWorld(i: number) {
        selectedWorld = ((i % n) + n) % n;
        worldChips.forEach((c, j) => c.classList.toggle("sel", j === selectedWorld));
        layout(true);
      }
      // Swipe: drag the strip live and snap to the nearest chip on release;
      // a short flick past FLICK px still advances one step. Pointer capture
      // is taken only ONCE the drag crosses the swipe threshold — capturing
      // at pointerdown retargeted the derived click to the strip, so tapping
      // a peeked neighbour never reached the chip's click handler.
      let downX: number | null = null;
      let captured = false;
      wrap.addEventListener("pointerdown", (e) => {
        downX = e.clientX;
        captured = false;
      });
      wrap.addEventListener("pointermove", (e) => {
        if (downX === null) return;
        // clientX is VIEWPORT px but the strip's transforms live inside the
        // uiZoom'd overlay — divide by the zoom or the chips move zoom×
        // faster than the finger (one phone swipe leapt two chips).
        const zoom = parseFloat(getComputedStyle(overlay).zoom as string) || 1;
        dragDx = (e.clientX - downX) / zoom;
        if (!captured && Math.abs(dragDx) > 6) {
          captured = true;
          swallowClick = true;
          wrap.setPointerCapture(e.pointerId); // keep the gesture off-row
        }
        layout(false);
      });
      const finish = () => {
        if (downX === null) return;
        // Variable-width snap: the chip whose centre ended nearest the
        // strip's centre wins; a short flick that didn't get that far
        // still advances one step in the drag direction.
        const xs = chipXs();
        let best = selectedWorld;
        for (let i = 0; i < n; i++)
          if (Math.abs(xs[i] + dragDx) < Math.abs(xs[best] + dragDx)) best = i;
        if (best === selectedWorld && Math.abs(dragDx) > FLICK)
          best = mod(selectedWorld - Math.sign(dragDx));
        downX = null;
        dragDx = 0;
        selectWorld(best);
        setTimeout(() => (swallowClick = false), 0); // click fires before this
      };
      wrap.addEventListener("pointerup", finish);
      wrap.addEventListener("pointercancel", finish);
      // Uncaptured pointers (pre-threshold) can exit the row without an up.
      wrap.addEventListener("pointerleave", () => {
        if (!captured) finish();
      });
      // Desktop nicety: the wheel steps the carousel too.
      let wheelAt = 0;
      wrap.addEventListener("wheel", (e) => {
        e.preventDefault();
        const now = performance.now();
        if (now - wheelAt < 200) return;
        wheelAt = now;
        selectWorld(selectedWorld + Math.sign(e.deltaY || e.deltaX));
      }, { passive: false });
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
  /* deep blue-slate night stone (the select-3 concept's mood) — the stone
     art under a navy wash */
  .ml-overlay{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
    background:#0d101c linear-gradient(rgba(13,16,28,.84),rgba(13,16,28,.84));font-family:system-ui,sans-serif;color:#e8e8ec}
  .ml-overlay{background-image:linear-gradient(rgba(13,16,28,.84),rgba(13,16,28,.84)),url(/ui2/stone.png);
    background-size:auto,100% auto;background-repeat:repeat,repeat-y;image-rendering:pixelated}
  /* No vw/vh inside this overlay: it may carry a compensating CSS zoom
     (uiscale.ts) and viewport units would double-count under it. */
  /* Slim side padding: the ring frame provides the visual margin now, and
     the phone needs the width — two 152px character tracks + their gap must
     fit inside ring pads + panel (128px native portraits, never scaled). */
  .ml-panel{width:min(720px,100%);max-height:100%;overflow:auto;padding:16px 8px 12px;text-align:center}
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
  /* World SWIPE CAROUSEL (maintainer: save the screen space — selected in
     the middle, loops around, neighbours peek in from the edges). One
     chip-height clipping strip; chips are absolutely positioned around the
     centre by the carousel layout() and slide via transform. */
  .ml-worlds{position:relative;overflow:hidden;height:88px;padding:0;touch-action:pan-y;
    user-select:none;-webkit-user-select:none;cursor:grab}
  .ml-worlds:active{cursor:grabbing}
  /* natural chip width — the carousel measures each chip and spaces them
     an equal gap apart (uniform size was the old grid's constraint) */
  .ml-world{position:absolute;left:50%;top:2px;height:64px;display:flex;align-items:center;
    justify-content:center;gap:8px;padding:2px 12px 2px 6px;color:#dfe2ea;font-size:12px;text-shadow:0 1px 2px #000}
  .ml-world.anim{transition:transform .25s ease}
  .ml-world span{white-space:nowrap}
  /* themed world card (select-3 concept): full-bleed art, baked label; the
     selected card gets a gold outline + slight lift instead of the plate's
     baked glow */
  /* atlas ICON chip: square icon tile + label below. Triple-class
     selectors: these must OUTRANK .ml-world.sel/.press (the plate rules
     sit later in this sheet and tie on two classes). */
  .ml-world.ml-wicon{border:none;border-image:none;background:none;padding:0;
    flex-direction:column;gap:3px;height:auto}
  .ml-wicon-img{width:64px;height:64px;background-size:100% 100%;background-repeat:no-repeat;
    image-rendering:pixelated}
  .ml-world.ml-wicon.sel{border-image:none;background:none;color:#ffd678}
  .ml-world.ml-wicon.sel .ml-wicon-img{outline:2px solid #ffd678;outline-offset:1px;filter:brightness(1.1)}
  .ml-world.ml-wicon.press{border-image:none;background:none}
  .ml-world.ml-wicon.press .ml-wicon-img{filter:brightness(.88)}
  .ml-world.sel{border-image:url(/ui2/plate-selected.png) 56 fill / 13px;color:#ffd678}
  .ml-world.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  .ml-world-img{width:34px;height:34px;object-fit:cover;image-rendering:auto;flex:none}
  /* compact cards sized to their content (maintainer: the man/woman
     buttons were too big) — the portrait viewport crops the 112px canvas
     down to the figure, art at native 1:1 */
  .ml-grid{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;padding:2px}
  .ml-cell{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 10px;
    color:#dfe2ea;font-size:12px;text-shadow:0 1px 2px #000}
  .ml-cell.sel{border-image:url(/ui2/plate-selected.png) 56 fill / 13px;color:#ffd678}
  .ml-cell.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  .ml-sprite{image-rendering:pixelated;background-repeat:no-repeat;flex:none}
  .ml-portrait-box{width:48px;height:92px;overflow:hidden;position:relative;flex:none}
  .ml-portrait{position:absolute;left:-32px;top:-10px;width:112px;height:112px;image-rendering:pixelated}
  .ml-cell span{max-width:96px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* Action row: ONE height (64px, same as the world chips) for the trough,
     the dice and Enter — all buttons the same size, text centered. Wraps on
     narrow screens (inside the ring) so the trough never collapses: the
     Enter CTA drops to its own centred line instead. */
  .ml-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;justify-content:center;align-items:center}
  /* Name input = the select-3 STONE TABLET (9-slice so the carved corner
     scrolls never smear when the input flexes). */
  .ml-name{flex:1 1 170px;max-width:280px;min-width:170px;height:49px;padding:0 4px;border-style:solid;border-width:16px;
    border-image:url(/ui2/select3/name-tablet.png) 22 fill / 16px;image-rendering:pixelated;box-sizing:border-box;
    background:none;color:#e8e8ec;font-size:16px;text-align:center;text-shadow:0 1px 2px #000}
  .ml-name:focus{outline:none;color:#ffd678}
  /* ENTER WORLD = the gold gem plaque, its label baked in the art (the DOM
     text stays for a11y/e2e but renders invisible). */
  .ml-btn{display:flex;align-items:center;justify-content:center;flex:none;border:none;padding:0;
    width:141px;height:55px;background:url(/ui2/select3/enter-plaque.png) 50% 50% / 100% 100% no-repeat;
    image-rendering:pixelated;color:transparent;font:700 15px system-ui,sans-serif}
  .ml-btn.press{filter:brightness(.88)}
  @media (hover:hover){ .ml-btn:active{filter:brightness(.88)} }
  /* the dice keeps its wooden plate */
  .ml-ghost{width:49px;height:49px;background:none;color:#e8e8ec;font-size:18px;
    border-style:solid;border-width:13px;border-image:url(/ui2/plate-normal.png) 56 fill / 13px}
  .ml-ghost.press{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px;filter:none}
  /* install = the parchment scroll, text baked (DOM text invisible) */
  .ml-install{margin-top:12px;border:none;padding:0;width:235px;height:40px;
    background:url(/ui2/select3/install-scroll.png) 50% 50% / 100% 100% no-repeat;
    image-rendering:pixelated;color:transparent;font-size:13px;cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center}
  .ml-install.press{filter:brightness(.88)}
  @media (hover:hover){
    .ml-plated:active{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
    .ml-world.sel:active,.ml-cell.sel:active{border-image:url(/ui2/plate-pressed.png) 56 fill / 13px}
  }`;
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
}

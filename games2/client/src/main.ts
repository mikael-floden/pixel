import Phaser from "phaser";
import { loadManifest } from "./manifest";
import { loadMonsterManifest } from "./monsterManifest";
import { withFallback } from "./placeholder";
import { chooseCharacter } from "./select";
import { WorldScene } from "./scenes/WorldScene";
import { loadWorld, loadWorldsList } from "./maps";
import { MapPreviewScene } from "./scenes/MapPreviewScene";
import { setLoadingProgress, showLoading } from "./loading";
import { mountTheme } from "./theme";
import { mountAmbient } from "../../ambient/index";
import { gameAudio } from "../../composer/index";

// ---- PWA ----
// Capture the browser's install prompt the moment it fires (often before any
// UI exists) so the select screen can offer an "Install app" button
// (Android home screen). Registered at module scope on purpose.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  (window as any).__mlInstall = e;
  window.dispatchEvent(new Event("ml-can-install"));
});
// The service worker exists only for installability — it caches nothing
// (see public/sw.js). Dev stays SW-free so vite HMR is never in its path.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
// Block pinch-zoom in ALL modes. Under "Desktop site" the viewport meta
// (user-scalable=no included) is ignored, so CSS touch-action (index.html)
// plus these listeners are what actually enforce it: kill any multi-touch
// move before the browser turns it into a page zoom, and iOS's proprietary
// gesture events for good measure. Single-finger input (taps, list
// scrolling) is untouched.
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);
document.addEventListener("gesturestart", (e) => e.preventDefault());
// Portrait-only (for now): the manifest locks the installed app; in-browser
// the lock API only works in fullscreen contexts, so it's best-effort (the
// #ml-rotate CSS overlay in index.html covers plain browser landscape).
if (window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches) {
  (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("portrait")
    .catch(() => {});
}

async function bootMapPreview(): Promise<boolean> {
  if (location.hash !== "#map") return false;
  const world = await loadWorld();
  if (!world) {
    document.body.innerHTML =
      '<p style="color:#eef;font-family:monospace;padding:2rem">No map yet ' +
      "(maps2/worlds/&lt;name&gt;/world.json not found).</p>";
    return true;
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#12121c",
    pixelArt: true,
    scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
    scene: [MapPreviewScene],
  });
  game.registry.set("world", world);
  return true;
}

/** Build-version badge (git sha) so testers can tell which deploy they're
 * running. On the SELECT screen it sits quietly bottom-centre; once IN the
 * game it moves to the game view's bottom-right corner, just above the HUD
 * (maintainer 2026-07-30 mark) — as a small translucent chip with a border
 * so it reads against any world art. */
let versionEl: HTMLDivElement | null = null;
function showVersion() {
  const sha = (import.meta.env.VITE_GIT_SHA as string | undefined) || "dev";
  console.log(`[nangijala] build ${sha}`);
  const el = document.createElement("div");
  el.textContent = sha.slice(0, 9); // 9 chars — matches git's abbreviated hash (what's written in dev chat)
  el.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);" +
    "bottom:6px;z-index:50;" +
    "font:600 11px var(--mono, ui-monospace, monospace);letter-spacing:.06em;" +
    "color:var(--muted, #8a887f);opacity:.9;" +
    "pointer-events:none;user-select:none";
  document.body.appendChild(el);
  versionEl = el;
}
/** In-game placement: right-aligned over the world, above the HUD's top edge
 * (--hud-h is published in real px by hud.ts applyLayout). */
function versionBadgeIntoGame() {
  const el = versionEl;
  if (!el) return;
  el.style.left = "auto";
  el.style.transform = "none";
  el.style.right = "10px";
  el.style.bottom = "calc(var(--hud-h, 38.2dvh) + 8px)";
  el.style.padding = "3px 8px";
  el.style.borderRadius = "8px";
  el.style.background = "color-mix(in srgb, var(--bg, #faf9f5) 76%, transparent)";
  el.style.border = "1px solid var(--border, #e6e2d7)";
  (el.style as CSSStyleDeclaration & { backdropFilter: string }).backdropFilter = "blur(5px)";
  el.style.opacity = "1";
}

/** Poll /version and offer a one-click reload when a newer deploy is live. */
function watchForUpdates() {
  const mine = (import.meta.env.VITE_GIT_SHA as string | undefined) || "dev";
  if (mine === "dev") return; // local dev: vite HMR handles it
  const check = async () => {
    try {
      const res = await fetch("/version", { cache: "no-store" });
      if (!res.ok) return;
      const { sha } = (await res.json()) as { sha: string };
      if (sha && sha !== "dev" && sha !== mine) showUpdateBanner(sha);
    } catch {}
  };
  setInterval(check, 60_000);
}

let updateBannerShown = false;
function showUpdateBanner(sha: string) {
  if (updateBannerShown) return;
  updateBannerShown = true;
  // A star-shimmer chime so a new build is AUDIBLE with the tab backgrounded
  // (maintainer 2026-07-19) — you hear the deploy land without watching.
  gameAudio.notifyNewVersion();
  const el = document.createElement("div");
  // 9 hash chars — the SAME short form as the version badge and git's own
  // abbreviated hash (what's referenced in dev chat), so the two are
  // comparable at a glance.
  // Wording is maintainer-fixed: JUST "New version out <hash>" — no arrow,
  // no "tap to reload" (2026-07-17). Tapping still reloads.
  el.textContent = `New version out ${sha.slice(0, 9)}`;
  // Non-selectable on purpose (belt and braces with the global rule): a long
  // press used to text-select the hash and pop Chrome's search sheet mid-game.
  // Wording is maintainer-fixed: JUST "New version out <hash>". Wiki-style
  // toast now: a surface pill on the shared tokens, just below the CSS clock,
  // plain responsive px (no zoom compensation).
  el.style.cssText =
    "position:fixed;top:74px;left:50%;transform:translateX(-50%);z-index:100;cursor:pointer;" +
    "padding:9px 16px;border-radius:10px;" +
    "background:var(--surface, #fff);color:var(--accent-ink, #b45309);" +
    "border:1px solid var(--accent, #d97757);font:600 13.5px var(--sans, sans-serif);" +
    "box-shadow:var(--shadow, 0 4px 16px rgba(0,0,0,.2));" +
    "white-space:nowrap;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;" +
    "-webkit-tap-highlight-color:transparent";
  el.addEventListener("click", () => location.reload());
  document.body.appendChild(el);
}

async function boot() {
  // Shared wiki theme FIRST: tokens + the saved light/dark choice land before
  // any styled surface (badge, select, HUD) so nothing flashes unthemed.
  mountTheme();
  showVersion();
  watchForUpdates();
  // Composer's audition page (/#foley): every generated foley candidate,
  // playable on the real deploy — the maintainer's ears close the QA loop.
  if (location.hash === "#foley") {
    const { mountFoleyAudition } = await import("../../composer/audition");
    mountFoleyAudition();
    return;
  }
  if (await bootMapPreview()) return;
  const manifest = await loadManifest();
  // Monster catalog (the poring family) — served in parallel. Optional: a
  // missing/failed manifest just means no monsters render (never dead-end the
  // player over debug creatures).
  const monsterManifest = await loadMonsterManifest().catch((e) => {
    console.warn("[nangijala] monster manifest unavailable — no monsters will render:", e);
    return null;
  });
  // The art agents periodically reset/regenerate the roster, so it can be empty.
  // Never dead-end the player: fall back to a built-in "Wanderer" so the shared
  // world is always joinable (the world scene draws it procedurally).
  manifest.characters = withFallback(manifest.characters);

  // Pre-join screen: the player chooses BOTH a world (any playable maps2
  // world the maps agent has shipped — glow_test is the emissive showcase)
  // AND a character.
  const worlds = await loadWorldsList();

  // Audio (games2/composer, its own agent): the engine boots HERE — before the
  // select screen — so its buttons click, the AudioContext unlocks on the
  // first tap, and the title theme plays while choosing. (It used to init
  // after chooseCharacter, so the select screen was silent — maintainer
  // 2026-07-19.) The scene feeds it events; the world score starts on join.
  gameAudio.init();

  // Dead-connection rejoin fast path: WorldScene sets ml-rejoin before its
  // recovery reload — skip the select screen and re-enter with the remembered
  // choice, so a phone coming back from background is in the world within
  // seconds (position restored server-side via the token store).
  let choice: Awaited<ReturnType<typeof chooseCharacter>> | null = null;
  if (sessionStorage.getItem("ml-rejoin") === "1") {
    sessionStorage.removeItem("ml-rejoin");
    try {
      const saved = JSON.parse(localStorage.getItem("ml-last-choice") || "null") as {
        world?: string;
        characterUid?: string;
        name?: string;
      } | null;
      const character = manifest.characters.find((c) => c.uid === saved?.characterUid);
      const worldOk = worlds.length === 0 || worlds.some((w) => w.name === saved?.world);
      if (saved?.world && character && worldOk) {
        showLoading();
        choice = { world: saved.world, character, name: saved.name || "wanderer" };
      }
    } catch {}
  }
  const { world: worldName, character, name } = choice ?? (await chooseCharacter(manifest, worlds));
  versionBadgeIntoGame(); // leaving the select screen → the in-game corner chip

  // select.ts showed the loading overlay on commit; the world JSON is the
  // first slow step (a few MB on mobile), then WorldScene.preload takes over
  // the progress bar with the actual asset counts.
  setLoadingProgress(0.05, "Fetching world…");
  // The chosen isometric world (null if its world.json is missing; the world
  // scene then falls back to a plain ground).
  const world = await loadWorld(worldName);

  // Render at the DEVICE's real pixels, not CSS pixels. The canvas backing store
  // is RS× the CSS size; the camera zoom is RS× higher to keep the SAME view.
  // The speed zoom-OUT's fractional camera zoom then steps at device-pixel
  // granularity instead of coarse CSS pixels, so the pixels stop shimmering as
  // the zoom settles on a high-DPI phone (maintainer 2026-07-25). RS=1 (desktop,
  // standard-DPI, tests) is byte-identical to before — a built-in kill switch.
  // Phaser's Scale.RESIZE renders 1:1 CSS with no DPR knob, so we drive the fit
  // manually under Scale.NONE: backing = #game size × RS, canvas CSS = #game size.
  const RS = Math.min(4, Math.max(1, window.devicePixelRatio || 1));
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#12121c",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.NONE,
      width: Math.round(window.innerWidth * RS),
      height: Math.round(window.innerHeight * RS),
    },
    scene: [WorldScene],
  });
  game.registry.set("renderScale", RS);
  const fitCanvas = () => {
    const el = document.getElementById("game");
    const cv = game.canvas;
    if (!el || !cv) return;
    const cssW = el.clientWidth;
    const cssH = el.clientHeight;
    if (cssW < 1 || cssH < 1) return;
    const bw = Math.round(cssW * RS);
    const bh = Math.round(cssH * RS);
    if (game.scale.width !== bw || game.scale.height !== bh) game.scale.resize(bw, bh);
    cv.style.width = cssW + "px";
    cv.style.height = cssH + "px";
  };
  game.events.once(Phaser.Core.Events.READY, fitCanvas);
  window.addEventListener("resize", fitCanvas);
  const gameEl = document.getElementById("game");
  if (gameEl && "ResizeObserver" in window) new ResizeObserver(fitCanvas).observe(gameEl);

  game.registry.set("manifest", manifest);
  game.registry.set("monsterManifest", monsterManifest);
  game.registry.set("character", character);
  game.registry.set("name", name);
  game.registry.set("world", world);
  game.registry.set("worldName", worldName);

  // Ambient-life layer (games2/ambient/, its own agent): attaches to the
  // world scene from outside and only ever ADDS display objects — zero
  // gameplay impact by charter (see ambient/README.md).
  mountAmbient(game);
}

boot();

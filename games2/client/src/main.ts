import Phaser from "phaser";
import { loadManifest } from "./manifest";
import { withFallback } from "./placeholder";
import { chooseCharacter } from "./select";
import { WorldScene } from "./scenes/WorldScene";
import { loadWorld, loadWorldsList } from "./maps";
import { MapPreviewScene } from "./scenes/MapPreviewScene";
import { setLoadingProgress, showLoading } from "./loading";
import { applyUiZoom } from "./uiscale";

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
 * running. Centered at the bottom, styled like the in-game coordinate label
 * (light monospace on a dark outline), above every overlay (select screen,
 * loading screen, game HUD alike). */
function showVersion() {
  const sha = (import.meta.env.VITE_GIT_SHA as string | undefined) || "dev";
  console.log(`[nangijala] build ${sha}`);
  const el = document.createElement("div");
  el.textContent = sha.slice(0, 9); // 9 chars — matches the hashes in dev chat/commits
  el.style.cssText =
    "position:fixed;left:50%;bottom:6px;transform:translateX(-50%);z-index:50;" +
    "font:12px monospace;color:#cfd6ff;text-shadow:0 1px 2px #000,0 0 3px #000;" +
    "pointer-events:none;user-select:none";
  document.body.appendChild(el);
  applyUiZoom(el); // keep it readable under "Desktop site" too
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
  const el = document.createElement("div");
  el.textContent = `⬆ New version ${sha.slice(0, 7)} — tap to reload`;
  // Non-selectable on purpose (belt and braces with the global rule): a long
  // press used to text-select the hash and pop Chrome's search sheet mid-game.
  el.style.cssText =
    "position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:100;cursor:pointer;" +
    "padding:8px 16px;border-radius:8px;background:#111114f2;color:#ffd678;" +
    "border:1px solid #ffd67855;font:14px system-ui,sans-serif;box-shadow:0 4px 16px #000a;" +
    "user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;" +
    "-webkit-tap-highlight-color:transparent";
  el.addEventListener("click", () => location.reload());
  document.body.appendChild(el);
}

async function boot() {
  showVersion();
  watchForUpdates();
  if (await bootMapPreview()) return;
  const manifest = await loadManifest();
  // The art agents periodically reset/regenerate the roster, so it can be empty.
  // Never dead-end the player: fall back to a built-in "Wanderer" so the shared
  // world is always joinable (the world scene draws it procedurally).
  manifest.characters = withFallback(manifest.characters);

  // Pre-join screen: the player chooses BOTH a world (any playable maps2
  // world the maps agent has shipped — glow_test is the emissive showcase)
  // AND a character.
  const worlds = await loadWorldsList();

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

  // select.ts showed the loading overlay on commit; the world JSON is the
  // first slow step (a few MB on mobile), then WorldScene.preload takes over
  // the progress bar with the actual asset counts.
  setLoadingProgress(0.05, "Fetching world…");
  // The chosen isometric world (null if its world.json is missing; the world
  // scene then falls back to a plain ground).
  const world = await loadWorld(worldName);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#12121c",
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    scene: [WorldScene],
  });

  game.registry.set("manifest", manifest);
  game.registry.set("character", character);
  game.registry.set("name", name);
  game.registry.set("world", world);
  game.registry.set("worldName", worldName);
}

boot();

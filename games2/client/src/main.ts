import { renderRes, setFullBacking } from "./resolution";
import { zoneAt, zoneGrid, CELL_WU, WHOLE_WORLD, type ZoneCfg } from "@nangijala/shared";
import { mountFpsBadge } from "./fpsbadge";
import { paceInstall } from "./pacing";
import { multiPipeOn } from "./multipipe";
import Phaser from "phaser";
import { loadManifest } from "./manifest";
import { loadMonsterManifest } from "./monsterManifest";
import { loadNpcManifest, loadNpcPlacement } from "./npcManifest";
import { loadMonsterBootKinds } from "./monsterBoot";
import { loadAssetIndex, setImageSha } from "./assetver";
import { onBuildLive, buildSocketUp } from "./buildlive";
import { enterStaging, mergeStagingEntries, gameUrl } from "./staging";
import { withFallback } from "./placeholder";
import { chooseCharacter } from "./select";
import { WorldScene } from "./scenes/WorldScene";
import { loadWorld, loadWorldsList, loadWorldRoots, worldRoot, DEFAULT_WORLD } from "./maps";
import { MapPreviewScene } from "./scenes/MapPreviewScene";
import { setLoadingProgress, showLoading } from "./loading";
import { mountTheme } from "./theme";
import { registerGame } from "./gamefreeze";
import { openUpdateNotes, prefetchNotes } from "./updatenote";
import { mountAmbient } from "../../ambient/index";
import { gameAudio } from "../../composer/index";
import { sessionGet, sessionRemove, sessionSet } from "./sessionflag";
import { desktopSqueeze } from "./desktopsite";
import { mountDesktopSiteNotice } from "./desktopsitenotice";
import { highpInstall } from "./highp";

// EVERY SHADER COMPILES HIGHP (highp.ts; the maintainer's law, never change it):
// before any game exists, because Phaser compiles its shaders when one is made.
highpInstall();

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
// Portrait-only OUTSIDE the world (maintainer 2026-08-05: the WORLD plays
// landscape; title/select/loading stay upright). In the installed app the
// lock API works (fullscreen contexts) and this boot-time portrait lock
// covers the pre-game screens; hud.ts mountPageFrame RE-LOCKS to "any" the
// moment the world mounts — this line was the "nothing happens when I tilt"
// bug once landscape shipped: it silently kept the old portrait-only rule
// no matter what the manifest said. In a plain browser tab lock() rejects
// (not fullscreen) and rotation is native; the #ml-rotate CSS overlay
// covers the pre-game screens there.
if (window.matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches) {
  (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.("portrait")
    .catch(() => {});
}

async function bootMapPreview(): Promise<boolean> {
  if (location.hash !== "#map") return false;
  // WHICH world: the one you last played, else the default. `#map` previewed
  // DEFAULT_WORLD's data under a hardcoded ring_test image before this. The
  // roots come from the built manifest first, because a world's TREE is what
  // every URL below is built from.
  await loadWorldRoots();
  let name = DEFAULT_WORLD;
  try {
    const saved = JSON.parse(localStorage.getItem("ml-last-choice") || "null") as { world?: string } | null;
    if (saved?.world) name = saved.world;
  } catch {}
  const world = await loadWorld(name);
  if (!world) {
    document.body.innerHTML =
      `<p style="color:#eef;font-family:monospace;padding:2rem">No map yet ` +
      `(${worldRoot(name)}/${name}/world.json not found).</p>`;
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
  game.registry.set("worldName", name);
  return true;
}

/** Build-version badge (git sha) so testers can tell which deploy they're
 * running. ONE placement everywhere — bottom-centre on the select screen and
 * in the game alike (maintainer 2026-07-30: the consistent spot across the
 * whole game is the one to keep; an in-game bottom-right chip was tried and
 * taken back). Quiet muted mono, above every overlay, no zoom compensation. */
function showVersion() {
  const sha = (import.meta.env.VITE_GIT_SHA as string | undefined) || "dev";
  console.log(`[nangijala] build ${sha}`);
  const el = document.createElement("div");
  el.textContent = sha.slice(0, 9); // 9 chars — matches git's abbreviated hash (what's written in dev chat)
  el.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);" +
    "bottom:6px;z-index:50;" +
    "font:600 11px var(--mono, ui-monospace, monospace);letter-spacing:.06em;" +
    // Plain text, no effects — visibility comes from the COLOUR alone.
    // A FIXED mid grey, NOT a theme token: three of the four screens the badge
    // appears on are dark whatever the theme is (title veil and loading screen
    // are black, the select screen is dark forest art), while in-game it sits
    // on the HUD. A theme ink flips with the theme, not with what's actually
    // behind the text, which is how it ended up near-black on black
    // (maintainer 2026-07-30). This grey is measured to stay legible on every
    // one of those backdrops.
    "color:#8f8c83;" +
    "pointer-events:none;user-select:none";
  document.body.appendChild(el);
}

/** Poll /version and offer a one-click reload when a newer deploy is live. */
function watchForUpdates() {
  const mine = (import.meta.env.VITE_GIT_SHA as string | undefined) || "dev";
  if (mine === "dev") return; // local dev: vite HMR handles it
  const check = async () => {
    try {
      const res = await fetch("/version", { cache: "no-store" });
      if (!res.ok) return;
      const { sha, image } = (await res.json()) as { sha: string; image?: string };
      setImageSha(image); // a rollout changes the image; the `?v=` stamp follows it
      if (sha && sha !== "dev" && sha !== mine) void showUpdateBanner(sha);
    } catch {}
  };
  // THE INTERVAL FOLLOWS WHETHER ANYTHING ELSE IS LISTENING. In a world the
  // room's socket carries `build:live` the moment the store flips, so a poll
  // adds nothing and stays at a minute. With NO socket — the select screen, the
  // loading screen, a dropped connection — the poll is the only way to hear
  // anything, and a minute of it is what makes a person refresh the page by
  // hand. So poll every 5 s there instead. /version is ~110 bytes and
  // `no-store`, and the fast rate stops the moment a world is joined, which is
  // seconds later.
  //
  // setTimeout, not setInterval: the rate has to be re-decided after each
  // check, and an interval cannot change its own period. Each tick schedules
  // the next one and `check` never throws, so the chain cannot stop.
  const SOCKET_IS_LISTENING = 60_000;
  const NOTHING_IS_LISTENING = 5_000;
  const tick = async () => {
    await check();
    setTimeout(() => void tick(), buildSocketUp() ? SOCKET_IS_LISTENING : NOTHING_IS_LISTENING);
  };
  setTimeout(() => void tick(), buildSocketUp() ? SOCKET_IS_LISTENING : NOTHING_IS_LISTENING);

  // AND INSTANTLY, WHEN THERE IS A SOCKET. `check` is reused rather than
  // trusting the message's sha: it re-reads /version, which is the authority,
  // so a stale or spoofed broadcast cannot raise a banner for a build that is
  // not actually being served.
  onBuildLive(() => void check());
}

/** THE BOOT CHECK AGAINST /version. A page restored from the phone's cache can
 * run a bundle hours behind what the site serves: his 21:50 load on 2026-09-12
 * was a 49 s old document (`performance.now()`) on the 14:54 bundle while
 * production served 21:31's — the deploy guard's own logs prove production
 * never went backwards, and that window's `net` stats show all 733 asset
 * fetches from cache and none from the network (Chrome's tab restore prefers
 * the cache even for a `no-cache` document). The minute poll above only ever
 * offers the banner, so the stale build kept running until he tapped it (the
 * banner's wording and behaviour are the maintainer's and stay). So at boot,
 * ONCE, the served sha is read — `/version` is `no-store`, it always reaches
 * the server — and a page that is behind it reloads itself while the loading
 * screen is still up (a real reload revalidates the document); nothing is lost
 * yet. Never mid-game: once `new Phaser.Game` has been reached the answer only
 * feeds the banner. Never a loop: one boot reload per 60 s per tab
 * (sessionStorage) — a cache that keeps answering stale, or a rollout crossing
 * the load, gets the banner on the second pass. The rejoin flag (WorldScene's
 * recovery reload) is re-armed across the reload so the fast path still skips
 * the select screen. Gate: scripts/verify-bootversion.mjs. */
let bootReloadOpen = true;
async function reloadIfBehindAtBoot(): Promise<void> {
  const mine = (import.meta.env.VITE_GIT_SHA as string | undefined) || "dev";
  if (mine === "dev") return; // local dev: vite HMR handles it
  const rejoin = sessionGet("ml-rejoin") === "1"; // read before boot() consumes it
  try {
    const res = await fetch("/version", { cache: "no-store" });
    if (!res.ok) return;
    const { sha, image } = (await res.json()) as { sha?: string; image?: string };
    // BEFORE THE RETURNS BELOW. This read is the only one at boot, and the
    // ordinary case — nothing to reload — returns two lines down, so setting
    // the stamp after any of them would leave it unset on almost every boot.
    setImageSha(image);
    // WHICH LANE SERVED THIS PAGE. `sha` is the generation being served and
    // `image` is the container under it, so they differ EXACTLY when a fast-lane
    // generation is live — one line that answers "did the lane work?" beside the
    // build line, without reading /api/bundle. Not on the badge: its format and
    // placement are his, and this is a developer's fact, not a player's.
    console.log(
      `[nangijala] served by the ${sha && image && sha !== image ? "FAST LANE" : "container"}` +
        ` (served ${(sha || "?").slice(0, 9)}, image ${(image || "?").slice(0, 9)})`,
    );
    if (!sha || sha === "dev" || sha === mine) return;
    const key = "ml-boot-reload-at";
    const stamp = sessionGet(key);
    const last = Number(stamp || 0);
    const canRemember = sessionSet("ml-storage-probe", "1");
    sessionRemove("ml-storage-probe");
    // NO STORAGE, NO RELOAD — BANNER ONLY. The old comment here said "one
    // reload is still bounded by bootReloadOpen", and that is wrong:
    // `bootReloadOpen` is a module-level flag, so it is `true` again on every
    // load and bounds one reload PER LOAD, not per tab. Where sessionStorage
    // throws (private mode, blocked site data, an embedded webview) the 60 s
    // stamp cannot persist either, so the page reloads, comes back, decides it
    // is behind again, and reloads forever — measured on an identity mismatch
    // at 114 loads in 12 s. The banner still tells him a build is out, in his
    // own wording, and costs one tap.
    if (!canRemember || !bootReloadOpen || Date.now() - last < 60_000) {
      void showUpdateBanner(sha);
      return;
    }
    // Lost the write after the probe said it would work: do NOT reload
    // unmarked, or the next load has nothing to stop it doing the same again.
    if (!sessionSet(key, String(Date.now()))) {
      void showUpdateBanner(sha);
      return;
    }
    if (rejoin) sessionSet("ml-rejoin", "1");
    console.log(`[nangijala] build ${mine.slice(0, 9)} is behind the served ${sha.slice(0, 9)} — reloading`);
    location.reload();
  } catch {
    /* offline or a hiccup: the minute poll takes over */
  }
}

let updateBannerShown = false;
async function showUpdateBanner(sha: string) {
  if (updateBannerShown) return;
  updateBannerShown = true;
  // THE NOTES ARE FETCHED BEFORE THE TOAST IS RAISED (games-ui, maintainer
  // 2026-09-19: "Once we know a new version is out we fetch the data we need
  // and after that we display a 'new version out' popup to the player. When
  // the player clicks on the new version out toast the dialog will display
  // with the best possible size immediately"). So the dialog is built whole
  // and enters the document at its final size — there is nothing to load and
  // nothing to resize. prefetchNotes() is memoised and never rejects, so the
  // toast is at worst a few hundred ms later than it used to be.
  await prefetchNotes();
  // A star-shimmer chime so a new build is AUDIBLE with the tab backgrounded
  // (maintainer 2026-07-19) — you hear the deploy land without watching.
  gameAudio.notifyNewVersion();
  const el = document.createElement("div");
  // 9 hash chars — the SAME short form as the version badge and git's own
  // abbreviated hash (what's referenced in dev chat), so the two are
  // comparable at a glance.
  // Wording is maintainer-fixed: JUST "New version out <hash>" — no arrow,
  // no "tap to reload" (2026-07-17). Tapping opens the RELEASE NOTES for this
  // deploy (updatenote.ts, games-ui, maintainer 2026-09-18: "I want it to list
  // everything that has changed from the version I'm currently at to the
  // version I'm about to get") and that dialog's primary button reloads.
  el.textContent = `New version out ${sha.slice(0, 9)}`;
  // Non-selectable on purpose (belt and braces with the global rule): a long
  // press used to text-select the hash and pop Chrome's search sheet mid-game.
  // Wording is maintainer-fixed: JUST "New version out <hash>". Wiki-style
  // toast now: a surface pill on the shared tokens, plain responsive px (no
  // zoom compensation). QUIET, not orange (maintainer 2026-08-05): the
  // default ink + a plain border — the accent pair read as an alert for what
  // is only an FYI — and it sits a step lower, clear of the stat chips.
  // …and it hangs off the chips' MEASURED heights (bars.ts publishes
  // --bars-l-h / --bars-r-h from ResizeObservers) + the project's 10px
  // margin, so it clears them on a device whose font metrics make the chips
  // taller. It is CENTRED, so it can pass under either one — hence the max()
  // of both, not just the right chip's. The 78px fallbacks are this phone's
  // left-chip height, used on the select screen where there are no chips.
  // The chips themselves sit under the cutout inset (--ml-safe-top,
  // theme.ts), so the toast adds it too or it climbs back into them.
  el.style.cssText =
    "position:fixed;top:calc(var(--ml-safe-top, 0px) + max(var(--bars-l-h, 78px), var(--bars-r-h, 78px)) + 20px);left:50%;transform:translateX(-50%);z-index:100;cursor:pointer;" +
    "padding:9px 16px;border-radius:10px;" +
    "background:var(--surface, #fff);color:var(--ink, #1f1e1a);" +
    "border:1px solid var(--border, #e6e2d7);font:600 13.5px var(--sans, sans-serif);" +
    "box-shadow:var(--shadow, 0 4px 16px rgba(0,0,0,.2));" +
    "white-space:nowrap;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;" +
    "-webkit-tap-highlight-color:transparent";
  el.addEventListener("click", () => openUpdateNotes(sha));
  document.body.appendChild(el);
}

async function boot() {
  // Shared wiki theme FIRST: tokens + the saved light/dark choice land before
  // any styled surface (badge, select, HUD) so nothing flashes unthemed.
  mountTheme();
  showVersion();
  mountDesktopSiteNotice(); // a phone in "Desktop site" draws everything at half size (desktopsitenotice.ts)
  try {
    // `?fps=1` shows the frame meter and remembers it; `?fps=0` forgets. See fpsbadge.ts.
    // localStorage can THROW (private mode, blocked site data) — never let a meter stop the boot.
    const q = new URLSearchParams(location.search).get("fps");
    if (q === "1") localStorage.setItem("ml-fps", "1");
    else if (q === "0") localStorage.removeItem("ml-fps");
    if (localStorage.getItem("ml-fps") === "1") mountFpsBadge();
  } catch {
    /* no storage — no meter */
  }
  watchForUpdates();
  void reloadIfBehindAtBoot(); // in parallel with the catalogs below; ~one RTT, long before the world is up
  // Composer's audition page (/#foley): every generated foley candidate,
  // playable on the real deploy — the maintainer's ears close the QA loop.
  if (location.hash === "#foley") {
    // THE INDEX FIRST, EVEN HERE. This route used to return before
    // loadAssetIndex() below, so the audition pages never had one and every
    // take fell back to `?v=`. That was free while `?v=` still froze art; with
    // the art lane it grants nothing (cachepolicy.ts, `isArt`), so these two
    // tools would have lost 100% of their caching and re-downloaded every take
    // on every interaction. Awaited: a foley page is a list of audio URLs and
    // it stamps them immediately.
    await loadAssetIndex();
    const { mountFoleyAudition } = await import("../../composer/audition");
    void mountFoleyAudition();
    return;
  }
  // Composer's SCORE audition (/#score): every generated music bed, playable
  // with its measured loop point — the maintainer decides what plays where.
  // THE ASSET INDEX first of all (client/src/assetver.ts): every art URL
  // stamped after it lands carries a content hash instead of the build sha,
  // so a deploy no longer invalidates the whole browser cache. Awaited with the
  // manifests below; it never blocks a boot on its own (404 → `?v` fallback).
  const assetIndexReady = loadAssetIndex();
  if (location.hash === "#score") {
    await assetIndexReady; // same reason as #foley above
    const { mountScoreAudition } = await import("../../composer/scoreAudition");
    mountScoreAudition();
    return;
  }
  if (await bootMapPreview()) return;
  // The four boot catalogs and the asset index, IN PARALLEL — they are
  // independent documents (four serial awaits here cost a round trip each).
  // Monster and NPC catalogs are optional: a missing/failed one just means no
  // monsters / no people render (never dead-end the player over debug
  // creatures). The world list is what the pre-join screen offers: BOTH a
  // world (any published world) AND a character.
  const [manifest, monsterManifest, npcManifest, worlds] = await Promise.all([
    loadManifest(),
    loadMonsterManifest().catch((e) => {
      console.warn("[nangijala] monster manifest unavailable — no monsters will render:", e);
      return null;
    }),
    loadNpcManifest().catch((e) => {
      console.warn("[nangijala] npc manifest unavailable — no NPCs will render:", e);
      return null;
    }),
    loadWorldsList(),
    assetIndexReady,
  ]);
  // The art agents periodically reset/regenerate the roster, so it can be empty.
  // Never dead-end the player: fall back to a built-in "Wanderer" so the shared
  // world is always joinable (the world scene draws it procedurally).
  manifest.characters = withFallback(manifest.characters);

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
  if (sessionGet("ml-rejoin") === "1") {
    sessionRemove("ml-rejoin");
    try {
      const saved = JSON.parse(localStorage.getItem("ml-last-choice") || "null") as {
        world?: string;
        characterUid?: string;
        name?: string;
      } | null;
      const character = manifest.characters.find((c) => c.uid === saved?.characterUid);
      // A remembered world this build does not LIST may still be a staging
      // world (dev map streamed from the repo) — let the activation below
      // decide instead of bouncing the admin to the select screen.
      const worldOk = worlds.length === 0 || !!saved?.world;
      if (saved?.world && character && worldOk) {
        showLoading();
        choice = { world: saved.world, character, name: saved.name || "wanderer" };
      }
    } catch {}
  }
  const { world: worldName, character, name } = choice ?? (await chooseCharacter(manifest, worlds));

  // STAGING: the chosen world is not in this build (an admin's dev map, or a
  // remembered one that left the image). Flip every subsequent art/data URL
  // to the repo CDN (staging.ts) BEFORE anything world-shaped is fetched.
  // If activation fails, loadWorld below returns null and the scene falls
  // back to plain ground — same degradation as any missing world.
  if (!worlds.some((w) => w.name === worldName && !w.staging)) {
    // The tree comes from the picker entry we just registered (maps.ts
    // worldRoot); an unknown world answers with the default tree, which is what
    // this call passed before worlds3 existed.
    const ok = await enterStaging(worldName, worldRoot(worldName));
    if (ok && monsterManifest) {
      // The image's manifests were built from the CURATED root, so a dev
      // world's monsters/NPCs may be missing from them. The committed repo
      // copies have everything; merge in what this image lacks, with their
      // art URLs rewritten to the CDN.
      try {
        const full = (await (await fetch(gameUrl("/monsters.json"))).json()) as typeof monsterManifest;
        monsterManifest.monsters = mergeStagingEntries(monsterManifest.monsters, full.monsters ?? []);
      } catch {}
    }
    if (ok && npcManifest) {
      try {
        const full = (await (await fetch(gameUrl("/npcs.json"))).json()) as typeof npcManifest;
        npcManifest.npcs = mergeStagingEntries(npcManifest.npcs ?? [], full?.npcs ?? []);
      } catch {}
    }
    if (!ok) console.warn(`[staging] could not activate for "${worldName}" — falling back to image assets`);
  }

  // select.ts showed the loading overlay on commit; the world JSON is the
  // first slow step (a few MB on mobile), then WorldScene.preload takes over
  // the progress bar with the actual asset counts.
  setLoadingProgress(0.05, "Fetching world…");
  // The chosen isometric world (null if its world.json is missing; the world
  // scene then falls back to a plain ground).
  const world = await loadWorld(worldName);
  // WHO stands where, fetched at BOOT alongside the world (maintainer
  // 2026-08-06: "the loading restarts just before the game loads and once
  // loaded it takes ~0.5s before the NPC is drawn"). Both symptoms were one
  // mistake: spawnNpcs used to fetch this in create() and then start its own
  // loader batch, which re-fired the scene loader's progress events the
  // loading overlay is driven by (the bar restarted) and only delivered the
  // art after the world was already on screen (the pop-in). Fetched here, the
  // placement is ready before the scene exists and the art rides the normal
  // boot progress. Tiny file, and worlds without NPCs return [] instantly.
  // And WHICH MONSTER ART the boot batch carries (client/src/monsterBoot.ts):
  // the kinds with a spawn zone near where the player will stand; the rest
  // stream in the deferred batch. Same tiny file, same boot-time reasoning.
  // And THE ZONE GRID (spec/ZONES.md): the first room to join is the one
  // owning the world's spawn; a returning player is handed to the zone of
  // their saved spot by that room. No grid = one room for the whole map.
  const [npcPlacement, monsterBootKinds, zonesCfg] = await Promise.all([
    loadNpcPlacement(worldName).catch(() => []),
    loadMonsterBootKinds(worldName, world?.spawn ?? null),
    fetch(`/api/zones/${encodeURIComponent(worldName)}`, { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<ZoneCfg | null>) : null))
      .catch(() => null),
  ]);
  const zone =
    zonesCfg && world?.spawn
      ? zoneAt(zoneGrid(zonesCfg, world.width, world.height, CELL_WU), (world.spawn[0] + 0.5) * CELL_WU, (world.spawn[1] + 0.5) * CELL_WU)
      : WHOLE_WORLD;

  // Render at the DEVICE's real pixels, not CSS pixels. The canvas backing store
  // is RS× the CSS size; the camera zoom is RS× higher to keep the SAME view.
  // The speed zoom-OUT's fractional camera zoom then steps at device-pixel
  // granularity instead of coarse CSS pixels, so the pixels stop shimmering as
  // the zoom settles on a high-DPI phone (maintainer 2026-07-25). RS=1 (desktop,
  // standard-DPI, tests) is byte-identical to before — a built-in kill switch.
  // Phaser's Scale.RESIZE renders 1:1 CSS with no DPR knob, so we drive the fit
  // manually under Scale.NONE: backing = #game size × RS, canvas CSS = #game size.
  /* THE BACKING: devicePixelRatio (capped) TIMES THE RESOLUTION DIAL
   * (resolution.ts — 1, 2/3, 1/2, 1/3, 1/4, 1/8). `renderScale` is the EFFECTIVE
   * backing per CSS px, which is what every consumer wants (the ground
   * texture's world size, the pointer mapping); the scene's zoom re-derives
   * the full-resolution zoom and scales it by the dial, so the same world
   * fills the screen at the square of the fraction in fragments.
   * "ml-render-res" refits the canvas live; the scene's resize
   * handler re-zooms and re-makes the ground texture. */
  /* THE SCREEN'S REAL PIXELS, not the page's: under "Desktop site" the page is
   * laid out ~2.2x wider than the screen (desktopsite.ts), so devicePixelRatio
   * per CSS px backed the canvas at ~2.2x the pixels the screen has (his
   * girlfriend's phone: 2390 x 3912, "way overkill as default"). Dividing by
   * the squeeze backs it at the screen's own pixels, and the camera's integer
   * zoom then lands where a device-width phone's does. 1 everywhere else. */
  const rsFull = () => Math.max(1, Math.min(4, Math.max(1, window.devicePixelRatio || 1)) / desktopSqueeze());
  const rsNow = () => rsFull() * renderRes();
  bootReloadOpen = false; // from here a late /version answer only banners — never a reload with a game up
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    backgroundColor: "#12121c",
    pixelArt: true,
    // 16 textures a draw on a phone too — opt-in (multipipe.ts: ?multipipe=1, Settings→Dev).
    autoMobilePipeline: !multiPipeOn(),
    scale: {
      mode: Phaser.Scale.NONE,
      width: Math.round(window.innerWidth * rsNow()),
      height: Math.round(window.innerHeight * rsNow()),
    },
    scene: [WorldScene],
  });
  game.registry.set("renderScale", rsNow());
  game.registry.set("renderRes", renderRes());
  // FRAME PACING (pacing.ts): a steady 30 when 60 cannot be held. Wraps the
  // loop's step; `?pace=auto|30|off` / Settings→Dev "frame pacing" choose.
  paceInstall(game);
  // A REAL touch device — hud.ts's touchDevice(), inlined (no import: keep
  // main.ts free of the HUD module graph). Gates the rotation coherence
  // check below so desktop is never affected.
  const touch = () =>
    (navigator.maxTouchPoints || 0) > 0 ||
    window.matchMedia?.("(pointer: coarse)").matches === true;
  const fitCanvas = () => {
    // ROTATION FLIP (hud.ts beginFlip): while an orientation transition is
    // live, HOLD FIRE. A real rotation restages the viewport several times,
    // and a full scale.resize per stage — framebuffer realloc + whole-world
    // redraw, back to back — stalls the main thread long enough that the OS
    // composites stale letterboxed frames (maintainer's mid-rotation
    // screenshots, 2026-08-05). The flip veil covers the stale-sized canvas;
    // when the viewport settles, hud.ts fires ONE "ml-flip-flush" and the
    // canvas takes its final size in a single resize.
    const root = document.documentElement;
    if (root.classList.contains("ml-flip")) return;
    // The FIRST stage sneaks past that class: the #game ResizeObserver
    // delivers BEFORE the window resize event that starts the flip (traced
    // live — the observer's scale.resize beat beginFlip by 3ms and cost a
    // ~2s stall). Same coherence test as the hud's snapshot guard: in-game
    // on a touch device, an aspect that disagrees with ml-land means a
    // rotation is mid-flight — the flip's flush will call back.
    if (
      root.classList.contains("ml-ingame") &&
      touch() &&
      window.innerWidth > window.innerHeight !== root.classList.contains("ml-land")
    )
      return;
    const el = document.getElementById("game");
    const cv = game.canvas;
    if (!el || !cv) return;
    const cssW = el.clientWidth;
    const cssH = el.clientHeight;
    if (cssW < 1 || cssH < 1) return;
    const RS = rsNow();
    // A rotation into or out of the squeeze moves the scale: the scene zooms off the registry.
    if (game.registry.get("renderScale") !== RS) game.registry.set("renderScale", RS);
    setFullBacking(Math.round(cssW * rsFull()), Math.round(cssH * rsFull()));
    const bw = Math.round(cssW * RS);
    const bh = Math.round(cssH * RS);
    if (game.scale.width !== bw || game.scale.height !== bh) game.scale.resize(bw, bh);
    cv.style.width = cssW + "px";
    cv.style.height = cssH + "px";
    // TELL PHASER THE CANVAS MOVED/RESIZED (maintainer 2026-08-06: after
    // switching orientation, tapping the map walked to a different spot).
    // Phaser derives its pointer mapping — displayScale — from `canvasBounds`,
    // which it fills from getBoundingClientRect() on ITS own resize pass. We
    // set the canvas CSS size ourselves right here, AFTER that pass, so its
    // cached bounds keep the pre-rotation SIZE: measured mid-flip in
    // landscape, real canvas 526x393 but bounds still the portrait 393x526,
    // giving displayScale 2.677/1.494 where the truth is 2.0/2.0. Every tap
    // was then scaled by that error — ~98wu off in landscape, ~130wu after
    // rotating back. updateBounds() re-reads the rect and recomputes the
    // scale. refresh() is deliberately NOT used: in RESIZE mode its
    // updateScale() re-derives gameSize/baseSize/canvas.width from the PARENT
    // (ScaleManager.js, the RESIZE branch), which would throw away the
    // resolution scaling this game applies on purpose — a 393x526 box backed
    // by 786x1052. updateBounds() re-reads the rect but does NOT recompute
    // displayScale (Phaser only does that inside refresh), so apply Phaser's
    // own formula here, from the bounds it just corrected.
    game.scale.updateBounds();
    const cb = game.scale.canvasBounds;
    if (cb.width > 0 && cb.height > 0) {
      game.scale.displayScale.set(
        game.scale.baseSize.width / cb.width,
        game.scale.baseSize.height / cb.height,
      );
    }
  };
  game.events.once(Phaser.Core.Events.READY, fitCanvas);
  window.addEventListener("resize", fitCanvas);
  window.addEventListener("ml-flip-flush", fitCanvas);
  // Handedness swaps the menu column left<->right: the game view MOVES but
  // keeps its size, so the ResizeObserver never fires and only the bounds
  // POSITION goes stale. Same fix, different trigger.
  window.addEventListener("ml-hand", fitCanvas);
  window.addEventListener("ml-render-res", () => {
    game.registry.set("renderScale", rsNow());
    game.registry.set("renderRes", renderRes());
    fitCanvas();
  });
  const gameEl = document.getElementById("game");
  if (gameEl && "ResizeObserver" in window) new ResizeObserver(fitCanvas).observe(gameEl);

  (window as any).__mlGame = game; // debug handle (scale-manager QA)
  // The wiki drawer freezes the loop while it is open — a second document in
  // an iframe and a running game loop fight over the same main thread, and
  // the wiki lost (maintainer 2026-08-13). gamefreeze.ts is the seam.
  registerGame(game);
  game.registry.set("manifest", manifest);
  game.registry.set("monsterManifest", monsterManifest);
  game.registry.set("npcManifest", npcManifest);
  game.registry.set("npcPlacement", npcPlacement);
  game.registry.set("monsterBootKinds", monsterBootKinds);
  game.registry.set("character", character);
  game.registry.set("name", name);
  game.registry.set("world", world);
  game.registry.set("worldName", worldName);
  game.registry.set("zone", zone);
  game.registry.set("zonesCfg", zonesCfg);

  // Ambient-life layer (games2/ambient/, its own agent): attaches to the
  // world scene from outside and only ever ADDS display objects — zero
  // gameplay impact by charter (see ambient/README.md).
  mountAmbient(game);
}

/**
 * BOOT MUST NEVER DEAD-END ON A BLACK PAGE (maintainer 2026-08-15, with a
 * screenshot of exactly that: the version badge alone, nothing else).
 *
 * `showVersion()` runs before the first await, so the badge is what you get
 * when anything after it throws or hangs — and until now `boot()` was called
 * with no catch at all, so ONE rejected fetch on the path (loadManifest,
 * loadWorldsList) took the whole screen with it, silently, with nothing to
 * retry. The hang half is fixed at the source (fetchSoon in staging.ts); this
 * is the backstop for everything else, including whatever we break next.
 *
 * Deliberately dependency-free: inline styles, no theme tokens, no imports. If
 * boot died, anything it was supposed to set up may be missing, so this cannot
 * rely on any of it.
 */
boot().catch((err) => {
  console.error("[nangijala] boot failed:", err);
  try {
    if (document.getElementById("ml-bootfail")) return;
    const box = document.createElement("div");
    box.id = "ml-bootfail";
    box.setAttribute("role", "alert");
    box.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;gap:16px;" +
      "align-items:center;justify-content:center;padding:24px;text-align:center;background:#000;" +
      "color:#e8e6e1;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
    const h = document.createElement("div");
    h.textContent = "Nangijala could not start";
    h.style.cssText = "font-size:19px;font-weight:600";
    const p = document.createElement("div");
    p.textContent = "Something failed to load. Check your connection and try again.";
    p.style.cssText = "color:#a8a49c;max-width:22rem";
    const btn = document.createElement("button");
    btn.textContent = "Reload";
    btn.style.cssText =
      "font:inherit;font-weight:600;padding:11px 26px;border-radius:9px;border:1px solid #4a4640;" +
      "background:#d97757;color:#fff;cursor:pointer";
    btn.onclick = () => location.reload();
    box.append(h, p, btn);
    document.body.appendChild(box);
  } catch {}
});

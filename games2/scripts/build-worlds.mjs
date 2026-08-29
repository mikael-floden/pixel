// Emit the list of PLAYABLE worlds the client offers in the selector.
// A world is playable once the maps agent writes world.json under one of the
// two world trees (maps2/worlds for world@1/@2, maps2/worlds3 for
// pixel-maps3/world@1); this scans both and records a little metadata (grid
// size, spawn, schema, which tree, whether a preview/minimap image exists) →
// client/public/worlds.json. Regenerated at manifest time (npm run manifest),
// so new worlds appear on the next build.
//
// IN THE IMAGE THIS RUNS AGAINST THE CURATED ROOT (ASSETS_ROOT=/assets, the
// shipset emit), which holds `userWorlds` only — so production's worlds.json
// lists the published worlds and nothing else, whichever tree they came from.
// The dev worlds an admin can reach come from config/publish.json via the
// staging CDN instead (maps.ts stagingWorlds).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Thumbnails may ship as PNG or lossless WebP (the art domains are migrating).
import { IMG_EXTS } from "./imagelib.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..");
// THE TWO WORLD TREES. `maps2/worlds` holds world@1/world@2 (baked tile paths);
// `maps2/worlds3` holds pixel-maps3/world@1 (a ground NAME per cell, no art —
// tiles3 resolves what draws at draw time). Both parse through the same
// `parseWorld`, so a picker entry is the same shape either way; the tree is
// recorded as `root` so the client knows where the world's files live.
//
// ORDER IS LOAD-BEARING TWICE OVER: `maps2/worlds` is scanned first, so every
// existing entry keeps its exact fields (the default root is OMITTED, making
// those rows byte-identical to before worlds3 existed), and a name present in
// both trees resolves to the v2 one.
const WORLD_ROOT_DEFAULT = "maps2/worlds";
const WORLD_ROOTS = [WORLD_ROOT_DEFAULT, "maps2/worlds3"];
const OUT = join(GAME_ROOT, "client", "public", "worlds.json");

// Thumbnail stems the maps agent may render, and the extensions to try for
// each. WebP wins when a world ships both (a conversion in flight); a PNG-only
// world is unaffected, so the picker keeps its thumbnail either way.
// Which worlds an END USER may pick. Read from the publication policy so there
// is ONE place that answers "what is the real game" — an empty/missing list
// means "no gate", i.e. every world is offered, which is the pre-split
// behaviour and the safe default if the policy ever goes missing.
let USER_WORLDS = [];
try {
  USER_WORLDS = JSON.parse(readFileSync(join(GAME_ROOT, "config", "publish.json"), "utf8")).userWorlds ?? [];
} catch {}

const THUMB_STEMS = ["minimap", "overview", "preview", "demo"];
const THUMB_EXTS = ["webp", ...IMG_EXTS.filter((e) => e !== "webp")];

// A pretty label from a dir name: ring_test → "Ring Test".
function label(name) {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function firstExisting(dir, names) {
  for (const n of names) if (existsSync(join(dir, n))) return n;
  return null;
}

function scan() {
  const out = [];
  const seen = new Set();
  for (const root of WORLD_ROOTS) scanRoot(root, out, seen);
  // Stable order, with ring_test (the default) first.
  out.sort((a, b) => (a.name === "ring_test" ? -1 : b.name === "ring_test" ? 1 : a.name.localeCompare(b.name)));
  return out;
}

function scanRoot(root, out, seen) {
  const WORLDS_DIR = join(ASSETS_ROOT, ...root.split("/"));
  if (!existsSync(WORLDS_DIR)) return;
  for (const name of readdirSync(WORLDS_DIR)) {
    if (seen.has(name)) continue;
    const dir = join(WORLDS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const worldJson = join(dir, "world.json");
    if (!existsSync(worldJson)) continue; // not playable yet (previews only)
    let meta = {};
    try {
      const w = JSON.parse(readFileSync(worldJson, "utf8"));
      // world@1 carries size {w,h} (worlds can be non-square); ringworld@1 used
      // meta.n. Record both dimensions for the picker.
      const width = w.size?.w ?? w.top?.[0]?.length ?? w.meta?.n ?? null;
      const height = w.size?.h ?? w.top?.length ?? w.meta?.n ?? null;
      meta = { w: width, h: height, schema: w.schema ?? null, spawn: w.spawn ?? w.meta?.spawn ?? null };
    } catch {
      continue; // unparseable → skip
    }
    // A thumbnail if the maps agent rendered one (served under /assets).
    const img = firstExisting(
      dir,
      THUMB_STEMS.flatMap((stem) => THUMB_EXTS.map((e) => `${stem}.${e}`)),
    );
    seen.add(name);
    out.push({
      name,
      label: label(name),
      ...meta,
      preview: img ? `${root}/${name}/${img}` : null,
      // DEV MAP? Everything outside config/publish.json's `userWorlds` ships so
      // it WORKS (the server reads world.json off disk, so an absent map cannot
      // be joined at all) but is hidden from the picker unless you are signed in
      // as admin — see loadWorldsList. A product gate, not a security boundary:
      // the repo is public. The point is the game never OFFERS these.
      ...(USER_WORLDS.length && !USER_WORLDS.includes(name) ? { dev: true } : {}),
      // Only a NON-default tree is recorded, so every maps2/worlds row stays
      // exactly the object it was; the client reads `root` and falls back to
      // maps2/worlds when it is absent (maps.ts worldRoot).
      ...(root === WORLD_ROOT_DEFAULT ? {} : { root }),
    });
  }
}

const worlds = scan();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(worlds, null, 2));
console.log(`[worlds] ${worlds.length} playable world(s) -> client/public/worlds.json:`, worlds.map((w) => w.name).join(", ") || "(none)");

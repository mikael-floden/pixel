// Emit the list of PLAYABLE maps2 worlds the client offers in the selector.
// A world is playable once the maps agent writes maps2/worlds/<name>/world.json;
// this scans for those and records a little metadata (grid size, spawn, whether
// a preview/minimap image exists) → client/public/worlds.json. Regenerated at
// manifest time (npm run manifest), so new worlds appear on the next build.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..");
const WORLDS_DIR = join(ASSETS_ROOT, "maps2", "worlds");
const OUT = join(GAME_ROOT, "client", "public", "worlds.json");

// A pretty label from a dir name: ring_test → "Ring Test".
function label(name) {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function firstExisting(dir, names) {
  for (const n of names) if (existsSync(join(dir, n))) return n;
  return null;
}

function scan() {
  if (!existsSync(WORLDS_DIR)) return [];
  const out = [];
  for (const name of readdirSync(WORLDS_DIR)) {
    const dir = join(WORLDS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const worldJson = join(dir, "world.json");
    if (!existsSync(worldJson)) continue; // not playable yet (previews only)
    let meta = {};
    try {
      const w = JSON.parse(readFileSync(worldJson, "utf8"));
      const n = w.meta?.n ?? w.top?.length ?? w.width ?? null;
      meta = { n, schema: w.schema ?? null, spawn: w.meta?.spawn ?? w.spawn ?? null };
    } catch {
      continue; // unparseable → skip
    }
    // A thumbnail if the maps agent rendered one (served under /assets).
    const img = firstExisting(dir, ["minimap.png", "overview.png", "preview.png", "demo.png"]);
    out.push({
      name,
      label: label(name),
      ...meta,
      preview: img ? `maps2/worlds/${name}/${img}` : null,
    });
  }
  // Stable order, with ring_test (the default) first.
  out.sort((a, b) => (a.name === "ring_test" ? -1 : b.name === "ring_test" ? 1 : a.name.localeCompare(b.name)));
  return out;
}

const worlds = scan();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(worlds, null, 2));
console.log(`[worlds] ${worlds.length} playable world(s) -> client/public/worlds.json:`, worlds.map((w) => w.name).join(", ") || "(none)");

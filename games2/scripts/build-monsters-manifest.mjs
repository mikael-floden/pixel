// Emit a MONSTER manifest the web client loads (parallel to build-manifest.mjs
// for characters). Monster art lives in the sibling `monsters/` domain at the
// repo root: monsters/<id>/monster.json + horizontal animation STRIPS
// (monsters/<id>/animations/<anim>__<dir>.png, width = frames*48, height = 48).
// Strips are served under /assets/monsters/... (see client/vite.config.ts +
// server/index.ts allowlists). One entry per monster in roster order.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, ".."); // pixel/games2
// Art domains live at the repo root by default; ASSETS_ROOT overrides it (Docker).
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..");
const MONSTERS = join(ASSETS_ROOT, "monsters");
const ROSTER = join(MONSTERS, "config", "roster.json");

// Client-canonical direction order (matches shared DIRECTIONS + characters.json).
// monster.json keys animation directions by NAME (its own `directions` array is
// alphabetical/un-normalized), so we key by name and emit in THIS order.
const DIRECTIONS = ["south", "south-west", "west", "north-west", "north", "north-east", "east", "south-east"];

// Canonical emit order = @nangijala/shared MONSTER_KINDS. This build script runs
// under plain `node` and can't import the TS shared package, so the order is
// mirrored here for a DETERMINISTIC manifest (runtime keys monsters by id, so
// array order is presentation-only). Ids not in this list fall to the end in
// roster order.
const KIND_ORDER = ["poring", "forest_poring", "ice_poring", "lava_poring", "sand_poring", "water_poring"];

/** Read a PNG's [width, height] from its IHDR header (no image library). */
function pngDims(p) {
  const b = readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function scan() {
  const monsters = [];
  if (!existsSync(ROSTER)) {
    console.warn(`[monsters] no roster at ${ROSTER} — emitting empty manifest`);
    return monsters;
  }
  const roster = JSON.parse(readFileSync(ROSTER, "utf8"));
  const entries = [...(roster.monsters || [])].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a.id);
    const ib = KIND_ORDER.indexOf(b.id);
    return (ia < 0 ? KIND_ORDER.length : ia) - (ib < 0 ? KIND_ORDER.length : ib);
  });
  for (const entry of entries) {
    const id = entry.id;
    const monDir = join(MONSTERS, id);
    const monJson = join(monDir, "monster.json");
    if (!existsSync(monJson)) {
      console.warn(`[monsters] ${id}: no monster.json — skipping`);
      continue;
    }
    const m = JSON.parse(readFileSync(monJson, "utf8"));
    const frameW = m.size?.width ?? 48;
    const frameH = m.size?.height ?? 48;
    const aliases = m.animation_aliases || entry.aliases || { walk: "jump" };
    // Resolve the game-facing "walk" state through aliases to a real anim key.
    const walkAnim = aliases.walk || "jump";

    const animations = {}; // <animKey>: { <dir>: frameCount }
    const strips = {}; // <animKey>: { <dir>: served URL }
    for (const [animKey, anim] of Object.entries(m.animations || {})) {
      const perDirFrames = {};
      const perDirStrip = {};
      const dirs = anim.directions || {};
      for (const d of DIRECTIONS) {
        const dd = dirs[d];
        if (!dd || !dd.strip) continue;
        perDirFrames[d] = dd.frames;
        // strip is repo-relative (e.g. "poring/animations/jump__south.png").
        perDirStrip[d] = "/assets/monsters/" + dd.strip.split("\\").join("/");
      }
      if (Object.keys(perDirFrames).length) {
        animations[animKey] = perDirFrames;
        strips[animKey] = perDirStrip;
      }
    }

    monsters.push({
      id,
      name: m.name || entry.name || id,
      frameW,
      frameH,
      root: id, // repo-relative dir under monsters/
      walkAnim,
      animations,
      strips,
      aliases,
    });
  }
  return monsters;
}

const publicDir = join(GAME_ROOT, "client", "public");
mkdirSync(publicDir, { recursive: true });

const monsters = scan();
const out = {
  generatedFrom: "monsters/config/roster.json",
  directions: DIRECTIONS,
  monsters,
};
writeFileSync(join(publicDir, "monsters.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`[monsters] ${monsters.length} monsters -> client/public/monsters.json:`, monsters.map((x) => x.id).join(", ") || "(none)");

// Surface-contract gate (runs inside `npm test`): every tile category the
// PLAYABLE WORLDS use must have an explicit SURFACES entry. Unknown categories
// default to plain walkable ground, which breaks BOTH gameplay (players walk
// through new solids) and night lighting (the shader treats them as terrain
// and paints phantom block shadows outside their art).
//
// "Playable worlds" = every maps2/worlds/<name>/world.json — exactly what the
// in-game picker discovers. When a category is missing this prints a
// ready-to-paste proposal (name-hinted), so expanding the material set needs
// no special knowledge: add the material, run the tests, paste the proposed
// line into shared/src SURFACES, done.
//
// (The first-generation tiles/ registry and its emission demo were retired
// 2026-07-14; maps2 glow ships as tiles2/emission.json, whose SHAPE the
// client consumes directly — see WorldScene "tiles2-emission".)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseWorld, isKnownSurface } from "../shared/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../.."); // pixel repo root
const WORLDS_DIR = join(ROOT, "maps2", "worlds");

const SOLID_NAMES = /tree|boulder|spire|tower|obelisk|cactus|fence|railing|planter|hedge|wall|peak|mountain|crystal/;
const TERRAIN_NAMES = /cliff|stair|step|ramp|bank|ledge|bed|road|floor|deck|waterfall|grass|sand|snow|water|dirt|stone/;

const worldNames = existsSync(WORLDS_DIR)
  ? readdirSync(WORLDS_DIR).filter((n) => existsSync(join(WORLDS_DIR, n, "world.json")))
  : [];
if (worldNames.length === 0) {
  console.error("check-surfaces: FAIL — no maps2/worlds/*/world.json found (nothing playable to gate)");
  process.exit(1);
}
const used = new Set();
for (const n of worldNames) {
  const world = parseWorld(JSON.parse(readFileSync(join(WORLDS_DIR, n, "world.json"), "utf8")));
  if (!world) {
    console.error(`check-surfaces: could not parse maps2/worlds/${n}/world.json`);
    process.exit(1);
  }
  for (const row of world.rows) for (const c of row) if (c && c.t) used.add(c.t);
}

const unknownUsed = [...used].filter((t) => !isKnownSurface(t)).sort();
if (!unknownUsed.length) {
  console.log(
    `check-surfaces: OK — all ${used.size} categories across ${worldNames.length} maps2 worlds have SURFACES entries.`,
  );
  process.exit(0);
}

console.error(`\ncheck-surfaces: FAIL — the maps2 worlds use ${unknownUsed.length} categories with NO SURFACES entry.`);
console.error(`They default to walkable ground: players walk through them AND the night shader`);
console.error(`gives them phantom block shadows outside their art.`);
console.error(`Add entries to SURFACES in games2/shared/src/index.ts. Name-hinted proposals:\n`);
for (const cat of unknownUsed) {
  const hint = SOLID_NAMES.test(cat)
    ? "name suggests SOLID (impassable object)"
    : TERRAIN_NAMES.test(cat)
      ? "name suggests standable terrain"
      : "no name hint — decide: can players stand on it?";
  console.error(`  // ${cat}: ${hint}`);
  console.error(`  ${cat}: solid,                          // if impassable object`);
  console.error(`  ${cat}: ground(1.0, "grass"),         // if standable terrain (tune speed/sound)\n`);
}
process.exit(1);

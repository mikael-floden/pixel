// Surface-contract gate (runs inside `npm test`): every tile category the
// PLAYABLE WORLDS use must have an explicit SURFACES entry. Unknown categories
// default to plain walkable ground, which breaks BOTH gameplay (players walk
// through new solids) and night lighting (the shader treats them as terrain
// and paints phantom block shadows outside their art).
//
// "Playable worlds" = every maps2/worlds3/<name>/world.json (pixel-maps3: a
// ground NAME per cell, so a "category" here is a tiles3 ground type) — exactly
// what the in-game picker discovers. When one is missing this prints a
// ready-to-paste proposal (name-hinted), so expanding the ground set needs no
// special knowledge: add the ground, run the tests, paste the proposed line
// into shared/src SURFACES, done.
//
// (tiles2 and the world@1/@2 worlds were retired 2026-09-09 — history in git.)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseWorld, isKnownSurface } from "../shared/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../.."); // pixel repo root
const WORLDS_DIR = join(ROOT, "maps2", "worlds3");

const SOLID_NAMES = /tree|boulder|spire|tower|obelisk|cactus|fence|railing|planter|hedge|wall|peak|mountain|crystal/;
const TERRAIN_NAMES = /cliff|stair|step|ramp|bank|ledge|bed|road|floor|deck|waterfall|grass|sand|snow|water|dirt|stone/;

const worldNames = existsSync(WORLDS_DIR)
  ? readdirSync(WORLDS_DIR).filter((n) => existsSync(join(WORLDS_DIR, n, "world.json")))
  : [];
if (!existsSync(WORLDS_DIR)) {
  // AN ABSENT TREE IS "NOT CHECKED OUT HERE", NOT A FAILURE — the deploy's test
  // job sparse-checks-out games2 + characters2 + live and no world tree (the rule
  // check-scenery-bbox, shipset --check-policy and verify-deckwalk apply).
  console.log("check-surfaces: maps2/worlds3 not checked out — skipped");
  process.exit(0);
}
if (worldNames.length === 0) {
  console.error("check-surfaces: FAIL — maps2/worlds3 holds no <name>/world.json (nothing playable to gate)");
  process.exit(1);
}
const used = new Set();
for (const n of worldNames) {
  const world = parseWorld(JSON.parse(readFileSync(join(WORLDS_DIR, n, "world.json"), "utf8")));
  if (!world) {
    console.error(`check-surfaces: could not parse maps2/worlds3/${n}/world.json`);
    process.exit(1);
  }
  for (const row of world.rows) for (const c of row) if (c && c.t) used.add(c.t);
}

const unknownUsed = [...used].filter((t) => !isKnownSurface(t)).sort();
if (!unknownUsed.length) {
  console.log(
    `check-surfaces: OK — all ${used.size} grounds across ${worldNames.length} world(s) have SURFACES entries.`,
  );
  process.exit(0);
}

console.error(`\ncheck-surfaces: FAIL — the world uses ${unknownUsed.length} grounds with NO SURFACES entry.`);
console.error(`They default to walkable ground: players walk through them AND the night shader`);
console.error(`gives them phantom block shadows outside their art.`);
console.error(`Add entries to the SURFACES table in games2/shared/src/surfaces.ts, then re-run`);
console.error(`npm test. The tiles/maps2 agents are cleared to do this themselves so an art`);
console.error(`push is never blocked — full runbook: games2/SURFACES.md. Name-hinted proposals:\n`);
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

// Surface-contract gate (runs inside `npm test`): every tile category the
// WORLD uses must have an explicit SURFACES entry. Unknown categories default
// to plain walkable ground, which breaks BOTH gameplay (players walk through
// new trees) and night lighting (the shader treats them as terrain and paints
// phantom block shadows outside their art — the long "shadow sticks out" bug).
//
// When a category is missing, this script MEASURES its art and prints a
// ready-to-paste proposal, so expanding the tileset needs no special
// knowledge: add the tile, run the tests, paste the proposed line into
// shared/src SURFACES (adjust speed/sound to taste), done.
//
// Categories that exist in /tiles but are not used by the world only warn.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { parseWorld, isKnownSurface } from "../shared/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../.."); // pixel repo root
const TILES = join(ROOT, "tiles");
const WORLD = join(ROOT, "maps/world/world.json");
const W = 64, TOP = 8, MID = 21, BOT = 34;

/** Measure a tile PNG and propose a SURFACES classification from its shape —
 * the same evidence the lighting investigation used:
 * - art that rises far above the block top and never forms a full flat top
 *   diamond = a solid OBJECT (tree/boulder: impassable, art-lit);
 * - a full opaque flat top diamond = standable ground (possibly a tall
 *   cliff-like terrain tile);
 * - anything ambiguous is flagged for a human/loop decision. */
function measure(file) {
  const p = PNG.sync.read(readFileSync(file));
  const alpha = (x, y) =>
    x >= 0 && y >= 0 && x < p.width && y < p.height && p.data[(y * p.width + x) * 4 + 3] > 16;
  // The logical block sits at the BOTTOM of taller images (art rises above).
  const yOff = p.height - 64;
  let topDiamond = 0, topOpaque = 0, above = 0;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < W; x++) {
      const by = y - yOff; // row within the logical 64px block
      if (by < TOP) { if (alpha(x, y)) above++; continue; }
      // inside the ideal top diamond?
      const t = Math.abs(x + 0.5 - W / 2) / (W / 2);
      const lo = TOP + t * (MID - TOP), hi = BOT - t * (BOT - MID);
      if (by >= lo && by <= hi + (MID - TOP)) {
        topDiamond++;
        if (alpha(x, y)) topOpaque++;
      }
    }
  const flatTop = topDiamond > 0 && topOpaque / topDiamond >= 0.95;
  return { h: p.height, above, flatTop };
}

const SOLID_NAMES = /tree|boulder|spire|tower|obelisk|cactus|fence|railing|planter|hedge|wall|peak/;
const TERRAIN_NAMES = /cliff|stair|step|ramp|bank|ledge|bed|road|floor|deck|waterfall/;

function proposalFor(cat) {
  const f = join(TILES, cat, "tile_00.png");
  if (!existsSync(f)) return { verdict: "no art found", lines: [] };
  const m = measure(f);
  const facts = `art ${m.h}px tall, ${m.above}px opaque above the block top, flat top diamond: ${m.flatTop}`;
  // Art is decisive at the extremes; the middle band is a GAMEPLAY decision
  // (a walkable stair and an impassable fence can measure identically), so
  // it gets facts + a name-based hint + both candidate lines.
  if (m.above <= 60 && m.flatTop)
    return {
      verdict: `GROUND, high confidence (${facts}) — standable terrain; walls shade normally`,
      lines: [`${cat}: ground(1.0, "grass"), // TODO: tune speed/sound`],
    };
  if (m.h > 64 && m.above > 800 && !TERRAIN_NAMES.test(cat))
    return {
      verdict: `SOLID OBJECT, high confidence (${facts}) — impassable; lighting = art + soft cast shadow`,
      lines: [`${cat}: solid,`],
    };
  const hint = SOLID_NAMES.test(cat)
    ? "name suggests SOLID"
    : TERRAIN_NAMES.test(cat)
      ? "name suggests standable terrain"
      : "no name hint";
  return {
    verdict: `UNCERTAIN (${facts}; ${hint}) — decide: can players stand on it?`,
    lines: [`${cat}: solid,                          // if impassable object`, `${cat}: ground(1.0, "grass"),         // if standable terrain (tune speed/sound)`],
  };
}

const world = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")));
if (!world) {
  console.error("check-surfaces: could not parse world.json");
  process.exit(1);
}
const used = new Set();
for (const row of world.rows) for (const c of row) if (c) used.add(c.t);

const unknownUsed = [...used].filter((t) => !isKnownSurface(t)).sort();
const allCats = readdirSync(TILES).filter((d) => existsSync(`${TILES}/${d}/tile_00.png`));
const unknownUnused = allCats.filter((t) => !isKnownSurface(t) && !used.has(t)).sort();

if (unknownUnused.length)
  console.warn(
    `check-surfaces: ${unknownUnused.length} tile categories exist but are unused and unclassified (fine for now): ${unknownUnused.join(", ")}`,
  );

// Emission-contract gate: every world-used category must ALSO have an entry
// in tiles/emission.json (null = audited, does not glow). Without one the
// tile silently never glows — the "did anyone look at this tile?" audit trail
// is the point. Non-null entries are shape-checked so a typo can't ship a
// black light or a NaN radius into the shader palette.
const EMISSION = join(TILES, "emission.json");
let emissionFail = 0;
if (!existsSync(EMISSION)) {
  console.error("check-surfaces: FAIL — tiles/emission.json is missing (self-emission registry).");
  emissionFail++;
} else {
  const em = JSON.parse(readFileSync(EMISSION, "utf8"));
  const cats = em.categories ?? {};
  const missing = [...used].filter((t) => !(t in cats)).sort();
  if (missing.length) {
    console.error(
      `check-surfaces: FAIL — ${missing.length} world-used categories have no tiles/emission.json entry` +
        ` (add "cat": null if the tile does not glow):`,
    );
    for (const t of missing) console.error(`    "${t}": null,`);
    emissionFail++;
  }
  for (const [cat, e] of Object.entries(cats)) {
    if (e === null) continue;
    const bad =
      !Array.isArray(e.color) ||
      e.color.length !== 3 ||
      e.color.some((v) => typeof v !== "number" || v < 0 || v > 1) ||
      typeof e.strength !== "number" || e.strength < 0 || e.strength > 1 ||
      typeof e.radius !== "number" || !(e.radius > 0) ||
      !["static", "flicker", "pulse"].includes(e.anim) ||
      typeof e.self !== "number" || e.self < 0 || e.self > 1;
    if (bad) {
      console.error(`check-surfaces: FAIL — malformed emission entry for "${cat}": ${JSON.stringify(e)}`);
      console.error(`    expected { color: [0..1 ×3], strength: 0..1, radius: >0, anim: static|flicker|pulse, self: 0..1 }`);
      emissionFail++;
    }
  }
}

if (!unknownUsed.length) {
  if (emissionFail) process.exit(1);
  console.log(
    `check-surfaces: OK — all ${used.size} world categories have SURFACES + emission entries.`,
  );
  process.exit(0);
}

console.error(`\ncheck-surfaces: FAIL — the world uses ${unknownUsed.length} categories with NO SURFACES entry.`);
console.error(`They default to walkable ground: players walk through them AND the night shader`);
console.error(`gives them phantom block shadows outside their art. Add entries to SURFACES in`);
console.error(`games/nangijala/shared/src/index.ts. Measured proposals:\n`);
for (const cat of unknownUsed) {
  const p = proposalFor(cat);
  console.error(`  ${cat}: ${p.verdict}`);
  for (const line of p.lines) console.error(`    ${line}`);
  console.error("");
}
process.exit(1);

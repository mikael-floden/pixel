// THE LIGHT'S RAMP FIELD IS THE RESOLVER'S RAMPS (client/src/rampfield.ts).
//
// The lighting pass packs one corner mask per cell into its surface map so its
// surface walk hits a composed ramp's incline instead of a flat top plus a wall
// face (maintainer 2026-09-25: "Something is rendering over it I think!" — the
// light painted a step over every slope). The field restates the resolver's
// rule over the world grid; this pins the two together on every cell of the_game.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, viewFromDoc } from "../../client/src/tiles3.js";
import { rampMaskField } from "../../client/src/rampfield.js";
import { parseWorld } from "../../shared/src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const load = (rel: string) => JSON.parse(readFileSync(join(REPO, rel), "utf8"));
const WORLD = join(REPO, "maps2/worlds3/the_game/world.json");
const NEEDS = [
  "tiles/ground_types.json",
  "tiles/slopes/index.json",
  "tiles/patterns/index.json",
  "tiles/review/manifest.json",
  "tiles/tops/index.json",
  "tiles/fades/index.json",
  "tiles/resolve.json",
  "live/tuning/base_tile_sets.json",
  "live/feedback/tiles.json",
];
const MISSING = NEEDS.filter((p) => !existsSync(join(REPO, p)));
const skip = MISSING.length ? `not checked out: ${MISSING.join(", ")}` : !existsSync(WORLD) ? "no world" : false;

function resolver(slopeHeight: number) {
  return new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes: load("tiles/ground_types.json").grounds,
    patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"),
    tops: load("tiles/tops/index.json"),
    feedback: load("live/feedback/tiles.json").entries,
    wallOverrides: load("live/tuning/tile_walls.json").overrides,
    basePromotions: load("live/tuning/base_tiles.json").overrides,
    fades: load("tiles/fades/index.json"),
    slopes: load("tiles/slopes/index.json"),
    topWallOverrides: load("live/tuning/top_walls.json").overrides,
    topOverrides: load("live/tuning/tile_tops.json").overrides,
    storeyPitch: 15,
    footBoundary: true,
    deckBoundary: true,
    slopeHeight,
    warn: () => {},
  } as ConstructorParameters<typeof Tiles3>[0]);
}

test("the light's ramp field is the resolver's composed ramp on every cell of the_game (a deck's cell excepted)", { skip }, () => {
  const doc = JSON.parse(readFileSync(WORLD, "utf8"));
  const parsed = parseWorld(doc)!;
  const field = rampMaskField(parsed);
  const W = parsed.width;
  const decked = new Set<number>();
  for (const d of parsed.decks ?? []) for (const c of d.cells) decked.add(c.row * W + c.col);
  const out = resolver(1).resolveWindow(viewFromDoc(doc));
  let ramps = 0, bad = 0;
  const wrong: string[] = [];
  for (const c of out.cells) {
    const i = c.y * W + c.x;
    if (decked.has(i)) continue;
    const want = c.slope?.ramp ? c.slope.index : 0;
    if (want) ramps++;
    if (field[i] !== want) {
      bad++;
      if (wrong.length < 5) wrong.push(`${c.x},${c.y}: resolver ${want}, field ${field[i]}`);
    }
  }
  assert.deepEqual(wrong, [], `${bad} cells disagree`);
  assert.ok(ramps >= 1500, `${ramps} ramps on the_game`);
});

test("the ramp field: a one-level rise of the same ground raises the corners it touches; two levels, another ground or a plateau top do not", () => {
  // A 4x4 patch, the cell under test at (1,1) on level 2.
  const world = (lv: number[][], gr: string[][] = lv.map((r) => r.map(() => "grass"))) => ({
    width: 4,
    height: 4,
    rows: lv.map((r, y) => r.map((l, x) => ({ t: gr[y][x], l }))),
    liquids: ["water"],
  });
  const at = (w: ReturnType<typeof world>) => rampMaskField(w)[1 * 4 + 1];
  // North row one up: NW + NE.
  assert.equal(at(world([[3, 3, 3, 3], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]])), 12);
  // North row two up: a cliff, no ramp.
  assert.equal(at(world([[4, 4, 4, 4], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]])), 0);
  // The same rise in another ground: no ramp.
  assert.equal(at(world([[3, 3, 3, 3], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]], [["snow", "snow", "snow", "snow"], ["grass", "grass", "grass", "grass"], ["grass", "grass", "grass", "grass"], ["grass", "grass", "grass", "grass"]])), 0);
  // One up all round: a full plateau top, not a ramp.
  assert.equal(at(world([[3, 3, 3, 3], [3, 2, 3, 3], [3, 3, 3, 3], [3, 3, 3, 3]])), 0);
  // A liquid never ramps.
  assert.equal(at(world([[3, 3, 3, 3], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]], [["water", "water", "water", "water"], ["water", "water", "water", "water"], ["water", "water", "water", "water"], ["water", "water", "water", "water"]])), 0);
  // Under a deck the slab is the surface.
  const w = world([[3, 3, 3, 3], [2, 2, 2, 2], [2, 2, 2, 2], [2, 2, 2, 2]]);
  assert.equal(rampMaskField({ ...w, decks: [{ level: 5, cells: [{ col: 1, row: 1 }] }] })[5], 0);
});

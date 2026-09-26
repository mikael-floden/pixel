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
import { RAMP_CHAMFER, Tiles3, rampChamfers, rampIsCorner, viewFromDoc } from "../../client/src/tiles3.js";
import { SLOPE_MIX, rampMaskField, rampMaskRaw, slopeRunShares } from "../../client/src/rampfield.js";
import { rotateWorldDoc } from "../../client/src/viewrot.js";
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

function resolver(slopeHeight: number, shares?: { shares: Uint8Array; width: number }) {
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
    slopeShares: shares?.shares,
    slopeSharesW: shares?.width,
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
  let ramps = 0, bad = 0, chamfers = 0, folds = 0;
  const wrong: string[] = [];
  const nearDeck = (x: number, y: number) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (decked.has((y + dy) * W + x + dx)) return true; return false; };
  for (const c of out.cells) {
    const i = c.y * W + c.x;
    if (decked.has(i)) continue;
    const idx = c.slope?.ramp ? c.slope.index : 0;
    const want = idx & 15;
    if (want) ramps++;
    if (field[i] !== want) {
      bad++;
      if (wrong.length < 5) wrong.push(`${c.x},${c.y}: resolver ${want}, field ${field[i]}`);
    }
    // THE CHAMFER BIT IS THE FIELD'S RULE (the light derives it from the same masks).
    if (!want || nearDeck(c.x, c.y)) continue;
    const fieldSays = rampChamfers(field[i], (dx, dy) => field[(c.y + dy) * W + c.x + dx]);
    if (rampIsCorner(want)) (fieldSays ? chamfers++ : folds++);
    if (fieldSays !== ((idx & RAMP_CHAMFER) !== 0)) {
      bad++;
      if (wrong.length < 5) wrong.push(`${c.x},${c.y}: resolver chamfer ${(idx & RAMP_CHAMFER) !== 0}, field ${fieldSays}`);
    }
  }
  assert.deepEqual(wrong, [], `${bad} cells disagree`);
  assert.ok(ramps >= 1500, `${ramps} ramps on the_game`);
  console.log(`rampfield: ${ramps} ramps on the_game, corners: ${chamfers} chamfers (diagonal edges), ${folds} folds (square corners)`);
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

test("a corner ramp is a chamfer on a diagonal terrace edge and a fold on a square corner", () => {
  // A 12x12 patch: a one-level diamond (|dx| + |dy| <= 3) and, beside it, a one-level square.
  const W = 24, H = 12;
  const lv: number[][] = Array.from({ length: H }, () => new Array(W).fill(0));
  for (let y = 0; y < H; y++) for (let x = 0; x < 12; x++) if (Math.abs(x - 6) + Math.abs(y - 6) <= 3) lv[y][x] = 1;
  for (let y = 4; y <= 8; y++) for (let x = 16; x <= 20; x++) lv[y][x] = 1;
  const field = rampMaskField({ width: W, height: H, rows: lv.map((r) => r.map((l) => ({ t: "grass", l }))), liquids: [] });
  const at = (x: number, y: number) => rampChamfers(field[y * W + x], (dx, dy) => field[(y + dy) * W + x + dx]);
  // The diamond's NE-facing edge, level 0 cells hugging it: every corner cell there is a chamfer.
  let diag = 0, diagCh = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < 12; x++) if (lv[y][x] === 0 && rampIsCorner(field[y * W + x])) { diag++; if (at(x, y)) diagCh++; }
  assert.ok(diag >= 8 && diagCh === diag, `${diagCh} of ${diag} corner cells round the diamond are chamfers`);
  // The square's four outer corners (one raised corner each) keep the fold.
  for (const [x, y] of [[15, 3], [21, 3], [15, 9], [21, 9]]) {
    assert.ok(rampIsCorner(field[y * W + x]), `${x},${y} is a corner ramp`);
    assert.equal(at(x, y), false, `${x},${y} folds`);
  }
});

// THE AUTO MIX (maintainer 2026-09-26: "always have it on and use the following
// weights: off 2, 25% 1, 75% 3, 100% 2" — the switch's third stop is 50%).
test("the auto mix on the_game: one pick per run, the resolver climbs each run's share, the light's field agrees, off runs stay stairs", { skip }, () => {
  const doc = JSON.parse(readFileSync(WORLD, "utf8"));
  const parsed = parseWorld(doc)!;
  const W = parsed.width;
  const H = parsed.height;
  const shares = slopeRunShares(parsed);
  const raw = rampMaskRaw(parsed);
  // Every run is one share: no two 8-neighbour ramp cells differ.
  let split = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!raw[i]) continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (raw[j] && shares[j] !== shares[i]) split++;
      }
    }
  assert.equal(split, 0, "a run climbs one height end to end");
  // The mix is his weights, counted over runs.
  const runs = new Map<number, number>();
  const seen = new Uint8Array(W * H);
  for (let i0 = 0; i0 < W * H; i0++) {
    if (!raw[i0] || seen[i0]) continue;
    runs.set(shares[i0], (runs.get(shares[i0]) ?? 0) + 1);
    const st = [i0];
    seen[i0] = 1;
    while (st.length) {
      const i = st.pop()!;
      const x = i % W, y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (raw[j] && !seen[j]) { seen[j] = 1; st.push(j); }
      }
    }
  }
  const nRuns = [...runs.values()].reduce((a, b) => a + b, 0);
  const total = SLOPE_MIX.reduce((a, [, w]) => a + w, 0);
  for (const [sh, wt] of SLOPE_MIX) {
    const got = (runs.get(sh) ?? 0) / nRuns;
    assert.ok(Math.abs(got - wt / total) < 0.08, `${sh}%: ${(got * 100).toFixed(1)}% of ${nRuns} runs, his weight ${((wt / total) * 100).toFixed(1)}%`);
  }
  // The resolver wears each cell's own share, and the light's field is its ramps.
  const field = rampMaskField(parsed, shares);
  const out = resolver(1, { shares, width: W }).resolveWindow(viewFromDoc(doc));
  const decked = new Set<number>();
  for (const d of parsed.decks ?? []) for (const c of d.cells) decked.add(c.row * W + c.col);
  const wrong: string[] = [];
  let ramps = 0;
  for (const c of out.cells) {
    const i = c.y * W + c.x;
    const idx = c.slope?.ramp ? c.slope.index & 15 : 0;
    if (c.slope && !c.slope.ramp && wrong.length < 5) wrong.push(`${c.x},${c.y}: a half step under the mix`);
    if (idx) {
      ramps++;
      const rise = Math.max(1, Math.round(15 * shares[i] / 100));
      if (c.slope!.rise !== rise && wrong.length < 5) wrong.push(`${c.x},${c.y}: rise ${c.slope!.rise}, run share ${shares[i]}%`);
    }
    if (!decked.has(i) && field[i] !== idx && wrong.length < 5) wrong.push(`${c.x},${c.y}: resolver ${idx}, field ${field[i]}`);
  }
  assert.deepEqual(wrong, []);
  console.log(`auto mix: ${nRuns} runs (${[...runs].map(([k, v]) => `${k}%: ${v}`).join(", ")}), ${ramps} ramp cells`);
});

test("the auto mix is the same picture in every view rotation", { skip }, () => {
  const doc = JSON.parse(readFileSync(WORLD, "utf8"));
  const base = slopeRunShares(parseWorld(doc)!);
  const W = doc.size.w, H = doc.size.h;
  const turned = parseWorld(rotateWorldDoc(doc, 1))!;
  const t = slopeRunShares(turned);
  let diff = 0;
  // One quarter-turn: cell (x, y) -> (H-1-y, x) of an H-wide grid.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (base[y * W + x] !== t[x * turned.width + (H - 1 - y)]) diff++;
  assert.equal(diff, 0, `${diff} cells pick another height turned`);
});

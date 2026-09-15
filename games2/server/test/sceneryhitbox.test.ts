// THE ART IS DRAWN INSIDE ITS OWN HITBOX — one canvas for every facing.
//
// The maintainer, with the wiki open beside the game (2026-09-14): "the wiki
// hitbox is perfect on both scenery objects and in-game they don't align at
// all", and then, on the first fix, the correction that decides which side is
// wrong: "It's important to not move the hitbox to the scenery. The hitbox
// looks to be correctly placed against the wall already. To me it looks like
// it's the scenery that wasn't drawn inside the already correctly placed
// hitbox."
//
// So the FOOTPRINT is the fixed point — it is what the map agent places against
// a wall, and it stands where the state's SOUTH still says, because that is the
// frame the wiki drew the box on. A piece's rotations share that still's canvas
// and only their SILHOUETTE moves on it (a turned view shows the front of the
// base, so the alpha bbox reaches further down), and `fitSprite` used to pin the
// DRAWN frame's own foot to the placement point — which lifted turned art off
// its box by that difference: hearth_901's LIT_1 has its foot at y 112 facing
// south and at y 125 facing south-west, 13 px on a canvas the game draws at
// ~1.011, half a cell of iso ground.
//
// Two laws, tested here on the real world and the real documents:
//   1. THE STAMP mirrors what the renderer scales and anchors by — the PIECE's
//      base bbox height and the STATE's south still's foot.
//   2. THE RENDERER puts a facing's hitbox in the same place whatever that
//      frame's silhouette does, because it anchors on the south still's canvas
//      point; so the box the game collides with and the box drawn on the art are
//      one box. The CONTROL arm re-runs the old rule and asserts it still moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorld,
  buildTerrainGrid,
  stampSceneryCollision,
  sceneryDrawnPx,
  sceneryHitboxRec,
  hitboxPosFor,
  footprintBlocks,
  FOOTPRINT_LEVEL_SLACK,
  CELL_WU,
  ISO_GEOMETRY_MAPS3,
  type SceneryBboxDoc,
  type SceneryHitboxDoc,
} from "@nangijala/shared";
import { fitSprite, type BBox } from "../../client/src/scenery3";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const WORLD = join(REPO, "maps2", "worlds3", "the_game", "world.json");
const BBOX = join(REPO, "games2", "config", "scenery-bbox.json");
const HITBOX = join(REPO, "live", "tuning", "scenery_hitbox.json");
const skip = !existsSync(WORLD) || !existsSync(BBOX) || !existsSync(HITBOX);

/** Everything one placement's box needs, resolved from the two documents the
 *  way BOTH sides resolve it — written out here rather than called out of the
 *  stamp, so this is parity and not a tautology. */
function facts(pl: any, bbox: SceneryBboxDoc, hitbox: SceneryHitboxDoc) {
  const piece = bbox.pieces?.[pl.piece];
  const spr = (pl.state ? piece?.states?.[pl.state] : null) ?? piece?.sprite;
  const south = spr ? bbox.boxes?.[spr] : undefined; // the STATE's south still
  const base = piece?.sprite ? bbox.boxes?.[piece.sprite] : undefined; // the PIECE's
  const rec = sceneryHitboxRec(hitbox, pl.piece, pl.state);
  const b = rec?.boxes?.[0];
  const wph = sceneryDrawnPx(piece?.wph, piece?.cpx);
  if (!piece || !south || !base || !b || !wph || rec?.no_collision || piece.flat) return null;
  const pos = hitboxPosFor(b, pl.dir || "south");
  return {
    /** The STATE's south still: its alpha bbox, and the canvas it lives on —
     *  which every rotation of that state shares. */
    south: [south[0], south[1], south[2], south[3]] as BBox,
    canvas: { w: south[4], h: south[5] },
    k: wph / Math.max(1, base[3] - base[1]),
    wantH: wph,
    baseH: Math.max(1, base[3] - base[1]),
    ax: pl.hflip ? -pos.ax : pos.ax,
    ay: pos.ay,
  };
}

/** A rotation's silhouette, as the library really differs: further down the
 *  SAME canvas (hearth_901 LIT_1 south-west is 13 px lower than its south
 *  still) and a texel or so sideways. The anchor law is exactly the claim that
 *  this may be anything at all without moving the box. */
const TURNED: ((s: BBox) => BBox)[] = [
  (s) => [s[0], s[1], s[2], s[3] + 13],
  (s) => [s[0] - 2, s[1] - 6, s[2] + 1, s[3] + 13],
  (s) => [s[0] + 4, s[1] + 2, s[2] - 3, s[3] - 5],
];

test("every footprint is stamped where the two documents put it", { skip }, () => {
  const bbox = JSON.parse(readFileSync(BBOX, "utf8")) as SceneryBboxDoc;
  const hitbox = JSON.parse(readFileSync(HITBOX, "utf8")).overrides as SceneryHitboxDoc;
  const world = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  stampSceneryCollision(grid, world.scenery ?? [], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  const fp = grid.footprints;
  assert.ok(fp && fp.n > 0, "the world stamps footprints at all");

  const { dx, dy } = ISO_GEOMETRY_MAPS3;
  let checked = 0;
  let worst = 0;
  let worstAt = "";
  for (let i = 0; i < fp!.n; i++) {
    const pl = (world.scenery ?? [])[fp!.place[i]];
    const f = facts(pl, bbox, hitbox);
    if (!f) continue;
    // The published box, from the frame's centre, in the scale the PIECE draws
    // at, hung off the SOUTH still's foot — screen px, then cells.
    const sx = (f.canvas.w / 2 + f.ax - (f.south[0] + Math.max(1, f.south[2] - f.south[0]) / 2)) * f.k;
    const sy = (f.canvas.h / 2 + f.ay - f.south[3]) * f.k;
    const want = { x: pl.x + (sx / dx + sy / dy) / 2, y: pl.y + (sy / dy - sx / dx) / 2 };
    const d = Math.hypot(fp!.cx[i] - want.x, fp!.cy[i] - want.y);
    if (d > worst) { worst = d; worstAt = `${pl.piece} ${pl.state ?? ""} ${pl.dir ?? "south"}`; }
    checked++;
  }
  console.log(`  ${checked} footprints checked against the documents; worst ${worst.toFixed(4)} cells (${worstAt})`);
  assert.ok(checked > 500, `the world offers footprints to check (${checked})`);
  assert.ok(worst < 0.02, `a footprint stands ${worst.toFixed(3)} cells off its own box (${worstAt})`);
});

test("a facing's hitbox lands in one place, whatever that frame's silhouette does", { skip }, () => {
  const bbox = JSON.parse(readFileSync(BBOX, "utf8")) as SceneryBboxDoc;
  const hitbox = JSON.parse(readFileSync(HITBOX, "utf8")).overrides as SceneryHitboxDoc;
  const world = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;

  /** Where the RENDERER puts the hitbox, relative to the placement's anchor:
   *  WorldScene's own `hbX`/`hbY`, off a fit of the frame being drawn. */
  const drawnAt = (f: NonNullable<ReturnType<typeof facts>>, drawn: BBox, hflip: boolean, anchor: BBox | null) => {
    const fit = fitSprite(drawn, f.canvas, f.wantH, 0, 0, hflip, f.baseH, anchor);
    return {
      x: fit.x + (f.canvas.w / 2 + f.ax - fit.sx) * fit.kx,
      y: fit.y + (f.canvas.h / 2 + f.ay - fit.sy) * fit.ky,
    };
  };

  let checked = 0;
  let worst = 0;
  let worstAt = "";
  let moved = 0;
  let movedWorst = 0;
  for (const pl of (world.scenery ?? []) as any[]) {
    const f = facts(pl, bbox, hitbox);
    if (!f) continue;
    // The stamp's own screen offsets, which the test above proved are the
    // footprint's: the box hung off the south still's foot.
    const sx = (f.canvas.w / 2 + f.ax - (f.south[0] + Math.max(1, f.south[2] - f.south[0]) / 2)) * f.k;
    const sy = (f.canvas.h / 2 + f.ay - f.south[3]) * f.k;
    for (const turn of TURNED) {
      const drawn = turn(f.south);
      const now = drawnAt(f, drawn, !!pl.hflip, f.south);
      const d = Math.max(Math.abs(now.x - sx), Math.abs(now.y - sy));
      if (d > worst) { worst = d; worstAt = `${pl.piece} ${pl.state ?? ""} ${pl.dir ?? "south"}`; }
      // THE CONTROL: the old rule pinned the drawn frame's own foot.
      const then = drawnAt(f, drawn, !!pl.hflip, null);
      const m = Math.max(Math.abs(then.x - sx), Math.abs(then.y - sy));
      if (m > 1) moved++;
      if (m > movedWorst) movedWorst = m;
      checked++;
    }
    // The south still itself draws exactly as it always did — the anchor is its
    // own foot, so the fit is bit-for-bit today's (and render3's) paste.
    const south = drawnAt(f, f.south, !!pl.hflip, f.south);
    const bare = drawnAt(f, f.south, !!pl.hflip, null);
    assert.deepEqual(south, bare, `the south still moved on ${pl.piece}`);
  }
  console.log(`  ${checked} facing fits: worst ${worst.toFixed(2)} px off the stamp; the old rule moved ${moved} of them, worst ${movedWorst.toFixed(1)} px`);
  assert.ok(checked > 1000, `the world offers placements to fit (${checked})`);
  /* THE RESIDUAL IS THE INTEGER CROP, not the anchor: the renderer draws a
   * whole number of pixels (`rint`) and maps the box through the scale it
   * actually applied (`w / sw`), while the stamp uses the exact k — over the
   * ~60 px lever from the canvas centre to the box that is worth a couple of
   * pixels on the most aggressively re-cropped silhouettes here, and less on a
   * real rotation, which is within a few texels of its south still. 13 px is
   * the bug; 2 is the rounding that has always been there. */
  assert.ok(worst <= 2.5, `the drawn box stands ${worst.toFixed(2)} px off the footprint (${worstAt})`);
  assert.ok(moved > 0, "the control found no difference — this test is no longer testing anything");
});

test("the hearth he reported: its south-west art is pasted 13 px lower, and its box does not move", { skip }, () => {
  const bbox = JSON.parse(readFileSync(BBOX, "utf8")) as SceneryBboxDoc;
  const south = bbox.boxes?.["hearths/hearth_901/lit_1/sprite.webp"];
  assert.ok(south, "hearth_901 LIT_1 is in the bbox doc");
  const piece = bbox.pieces?.["hearths/hearth_901"]!;
  const base = bbox.boxes?.[piece.sprite!]!;
  const wantH = sceneryDrawnPx(piece.wph, piece.cpx)!;
  const baseH = Math.max(1, base[3] - base[1]);
  const canvas = { w: south![4], h: south![5] };
  // MEASURED off scenery/hearths/hearth_901/lit_1/rotations/south-west.webp.
  const sw: BBox = [10, 6, 119, 125];
  const anchored = fitSprite(sw, canvas, wantH, 0, 0, false, baseH, [south![0], south![1], south![2], south![3]]);
  const bare = fitSprite(sw, canvas, wantH, 0, 0, false, baseH);
  // 13 px of silhouette at the scale the piece draws (88/87), then Math.trunc.
  assert.ok(
    Math.abs(anchored.y - bare.y - 13 * anchored.ky) <= 1,
    `the turned art is pasted a silhouette's difference lower (${anchored.y - bare.y} px)`,
  );
  // Its canvas foot — the point the box hangs off — is back on the anchor.
  const foot = anchored.y + (south![3] - anchored.sy) * anchored.ky;
  assert.ok(Math.abs(foot) <= 1, `the south foot lands on the placement point (${foot.toFixed(2)} px off)`);
});

/* A CHIMNEY STANDS ON THE ROOF; A WINDOW HANGS ON THE WALL. Both carry a `z`,
 * and stampSceneryCollision used to skip every placement that had one — "a
 * window or a hanging hangs on the wall behind the cell; the wall blocks" —
 * which is right for the window and wrong for the chimney. All ten of
 * the_game's chimneys carry z:6 and not one of them blocked anything
 * (maintainer 2026-09-15, standing on a roof a monster had pushed him onto:
 * "the hitbox on the chimney is not working"; he took fall damage jumping off,
 * so the roof position was real).
 *
 * BOTH HALVES ARE THE CLAIM. A chimney must block a body ON ITS ROOF, and it
 * must NOT block one in the room underneath — a footprint filed at the base
 * level would put an invisible pillar in the middle of somebody's floor, which
 * is the failure the level-aware footprint exists to prevent. */
test("a chimney is stamped on its roof, filed at the deck and not at the base", { skip }, () => {
  const bbox = JSON.parse(readFileSync(BBOX, "utf8")) as SceneryBboxDoc;
  const hitbox = JSON.parse(readFileSync(HITBOX, "utf8")).overrides as SceneryHitboxDoc;
  const world = parseWorld(JSON.parse(readFileSync(WORLD, "utf8")))!;
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  stampSceneryCollision(grid, world.scenery ?? [], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  const fp = grid.footprints;
  assert.ok(fp && fp.n > 0, "the world stamps footprints at all");

  const scen = world.scenery ?? [];
  // THE CHIMNEY'S OWN FOOTPRINT, by placement index — not "is anything here",
  // which a hearth or a wall piece on the floor below answers for free (the
  // first cut of this test asserted that and failed on chimney_022's own room).
  const ofPlace = new Map<number, number>();
  for (let i = 0; i < fp!.n; i++) ofPlace.set(fp!.place[i], i);

  let checked = 0;
  for (let pi = 0; pi < scen.length; pi++) {
    const c = scen[pi];
    if (!/chimney/.test(c.piece)) continue;
    const i = Math.floor(c.y) * grid.width + Math.floor(c.x);
    const deck = grid.deck[i];
    const base = grid.level[i];
    // Only the ones that really stand on a deck: a chimney the map hangs on a
    // wall is a window as far as collision is concerned, and is not this claim.
    if (!(deck >= 0 && base + (c.z ?? 0) >= deck - 1e-9)) continue;
    checked++;
    const f = ofPlace.get(pi);
    assert.ok(f !== undefined, `${c.piece} at ${c.x.toFixed(1)},${c.y.toFixed(1)} is stamped at all (z ${c.z} used to skip it outright)`);
    assert.equal(
      fp!.lvl[f!], deck,
      `${c.piece} is filed at its DECK (${deck}), not the base under it (${base})`,
    );
    // ...which is what keeps it out of the room below: the level-aware queries
    // skip a footprint further than FOOTPRINT_LEVEL_SLACK from the body.
    assert.ok(
      Math.abs(deck - base) > FOOTPRINT_LEVEL_SLACK,
      `${c.piece}'s roof is far enough above its own floor for the slack to separate them (${base} -> ${deck})`,
    );
    // At the footprint's OWN centre, not at the placement point: the ellipse is
    // hung off the published hitbox and sits a little off the anchor, so a
    // radius-0 probe at the anchor can fall outside its own box.
    assert.equal(
      footprintBlocks(grid, fp!.cx[f!] * CELL_WU, fp!.cy[f!] * CELL_WU, 0, deck), true,
      `${c.piece} blocks a body standing on its own roof`,
    );
  }
  assert.ok(checked > 0, "at least one chimney stands on a deck");
  console.log(`# ${checked} deck-standing chimney(s) stamped on their roofs`);
});

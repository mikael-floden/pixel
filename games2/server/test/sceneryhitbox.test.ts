// THE FOOTPRINT IS UNDER THE ART — the collision stamp must be `fitSprite`'s
// exact mirror, because one draws the piece and the other draws (and enforces)
// the ground it stands on.
//
// The maintainer, beside the wiki with two pieces open (2026-09-14): "the wiki
// hitbox is perfect on both scenery objects and in-game they don't align at
// all ... I feel the hitbox is perfectly drawn along the wall so it must be
// something we do when rendering the scenery." It was the stamp, in two ways,
// and both are re-derivations of what `fitSprite` already decides:
//
//   SCALE  — every frame of a piece draws at `drawnPx / the PIECE's base bbox
//            height`, so a state whose art is taller draws taller. The stamp
//            scaled the published ellipse by the STATE's own height: wrong for
//            610 of the_game's 1,335 ground placements, worst 36%.
//   ANCHOR — `fitSprite` stands the DRAWN frame's alpha bbox bottom-centre on
//            the placement point, and a turned frame's bbox is its own
//            (hearth_901's lit_1: 93 px tall, foot at y 112 facing south; 119
//            and 125 facing south-west). The stamp anchored every facing on the
//            south still, which put a turned piece's footprint 13 screen px —
//            half a cell of iso ground — in front of its own art.
//
// The reference below is written out from the two documents rather than by
// calling the stamp's own code, so this is a parity test and not a tautology;
// the CONTROL arm re-runs the old rule and asserts it disagrees, so the test
// cannot quietly pass on a build that has the bug back.
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
  ISO_GEOMETRY_MAPS3,
  type SceneryBboxDoc,
  type SceneryHitboxDoc,
} from "@nangijala/shared";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const WORLD = join(REPO, "maps2", "worlds3", "the_game", "world.json");
const BBOX = join(REPO, "games2", "config", "scenery-bbox.json");
const HITBOX = join(REPO, "live", "tuning", "scenery_hitbox.json");
const skip = !existsSync(WORLD) || !existsSync(BBOX) || !existsSync(HITBOX);

test("every footprint sits where fitSprite draws the art it belongs to", { skip }, () => {
  const doc = JSON.parse(readFileSync(WORLD, "utf8"));
  const bbox = JSON.parse(readFileSync(BBOX, "utf8")) as SceneryBboxDoc;
  const hitbox = JSON.parse(readFileSync(HITBOX, "utf8")).overrides as SceneryHitboxDoc;
  const world = parseWorld(doc)!;
  const grid = buildTerrainGrid(world.width, world.height, world.rows, world.props, world.decks);
  stampSceneryCollision(grid, world.scenery ?? [], bbox, hitbox, ISO_GEOMETRY_MAPS3);
  const fp = grid.footprints;
  assert.ok(fp && fp.n > 0, "the world stamps footprints at all");

  const { dx, dy } = ISO_GEOMETRY_MAPS3;
  /** Where the ellipse's centre belongs, in cells, written out from the two
   *  documents: `fitSprite`'s scale and the DRAWN frame's own anchor. */
  const expected = (pl: any, old = false) => {
    const facts = bbox.pieces?.[pl.piece];
    const spr = (pl.state ? facts?.states?.[pl.state] : null) ?? facts?.sprite;
    const bb = spr ? bbox.boxes?.[spr] : undefined;
    const baseBB = facts?.sprite ? bbox.boxes?.[facts.sprite] : undefined;
    if (!facts || !bb || !baseBB) return null;
    const rec = sceneryHitboxRec(hitbox, pl.piece, pl.state);
    const b = rec?.boxes?.[0];
    if (!b || rec?.no_collision || facts.flat) return null;
    const [bx0, , bx1, by1, fw, fh] = bb;
    const wph = sceneryDrawnPx(facts.wph, facts.cpx);
    if (!wph) return null;
    const dir = pl.dir || "south";
    // THE TWO RULES UNDER TEST, and the old ones the control re-runs.
    const k = old ? wph / Math.max(1, by1 - bb[1]) : wph / Math.max(1, baseBB[3] - baseBB[1]);
    const rot = pl.state ? facts.rots?.[pl.state]?.[dir] : undefined;
    const ax = old || !rot ? bx0 + Math.max(1, bx1 - bx0) / 2 : rot[0];
    const ay = old || !rot ? by1 : rot[1];
    const pos = hitboxPosFor(b, dir);
    const sx = (fw / 2 + (pl.hflip ? -pos.ax : pos.ax) - ax) * k;
    const sy = (fh / 2 + pos.ay - ay) * k;
    return { x: pl.x + (sx / dx + sy / dy) / 2, y: pl.y + (sy / dy - sx / dx) / 2 };
  };

  let checked = 0;
  let worst = 0;
  let worstAt = "";
  for (let i = 0; i < fp!.n; i++) {
    const pl = (world.scenery ?? [])[fp!.place[i]];
    const want = expected(pl);
    if (!want) continue;
    const d = Math.hypot(fp!.cx[i] - want.x, fp!.cy[i] - want.y);
    if (d > worst) { worst = d; worstAt = `${pl.piece} ${pl.state ?? ""} ${pl.dir ?? "south"}`; }
    checked++;
  }
  console.log(`  ${checked} footprints checked against the drawn art; worst ${worst.toFixed(4)} cells (${worstAt})`);
  assert.ok(checked > 500, `the world offers footprints to check (${checked})`);
  assert.ok(worst < 0.02, `a footprint stands ${worst.toFixed(3)} cells off its own art (${worstAt})`);
});

test("the OLD stamp rules really do move a turned piece's footprint (the control)", { skip }, () => {
  const doc = JSON.parse(readFileSync(WORLD, "utf8"));
  const bbox = JSON.parse(readFileSync(BBOX, "utf8")) as SceneryBboxDoc;
  const hitbox = JSON.parse(readFileSync(HITBOX, "utf8")).overrides as SceneryHitboxDoc;
  const world = parseWorld(doc)!;
  const { dx, dy } = ISO_GEOMETRY_MAPS3;
  // Same reference as above, both ways, over the turned placements only.
  const both = (pl: any) => {
    const facts = bbox.pieces?.[pl.piece];
    const spr = (pl.state ? facts?.states?.[pl.state] : null) ?? facts?.sprite;
    const bb = spr ? bbox.boxes?.[spr] : undefined;
    const baseBB = facts?.sprite ? bbox.boxes?.[facts.sprite] : undefined;
    const rec = sceneryHitboxRec(hitbox, pl.piece, pl.state);
    const b = rec?.boxes?.[0];
    const wph = sceneryDrawnPx(facts?.wph, facts?.cpx);
    if (!facts || !bb || !baseBB || !b || !wph || rec?.no_collision || facts.flat) return null;
    const [bx0, , bx1, by1, fw, fh] = bb;
    const dir = pl.dir || "south";
    const pos = hitboxPosFor(b, dir);
    const at = (k: number, ax: number, ay: number) => {
      const sx = (fw / 2 + (pl.hflip ? -pos.ax : pos.ax) - ax) * k;
      const sy = (fh / 2 + pos.ay - ay) * k;
      return { x: pl.x + (sx / dx + sy / dy) / 2, y: pl.y + (sy / dy - sx / dx) / 2 };
    };
    const rot = pl.state ? facts.rots?.[pl.state]?.[dir] : undefined;
    const now = at(wph / Math.max(1, baseBB[3] - baseBB[1]), rot ? rot[0] : bx0 + Math.max(1, bx1 - bx0) / 2, rot ? rot[1] : by1);
    const then = at(wph / Math.max(1, by1 - bb[1]), bx0 + Math.max(1, bx1 - bx0) / 2, by1);
    return Math.hypot(now.x - then.x, now.y - then.y);
  };
  const turned = (world.scenery ?? []).filter((p: any) => p.dir && p.dir !== "south" && !Number.isFinite(p.z));
  const moved = turned.map(both).filter((d): d is number => d !== null && d > 0.1);
  console.log(`  ${moved.length} of ${turned.length} turned placements move more than 0.1 cell between the old rules and the new`);
  assert.ok(turned.length > 0, "the world places pieces on turned facings");
  assert.ok(moved.length > 0, "the control found no difference — this test is no longer testing anything");
});

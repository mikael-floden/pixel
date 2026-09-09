import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHARACTER_BODY_PX,
  SCENERY_CONTRACT_CHARACTER_PX,
  ISO_GEOMETRY_MAPS3,
  buildTerrainGrid,
  footprintsInCells,
  sceneryDrawnPx,
  stampSceneryCollision,
  type SceneryBboxDoc,
  type SceneryHitboxDoc,
} from "../../shared/src/index";
// @ts-expect-error — plain ESM with no declaration, exactly as imagelib.test.ts imports it
import { imgAlpha } from "../../scripts/imagelib.mjs";

const GAME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(GAME_ROOT, "..");

test("sceneryDrawnPx re-bases the contract's px to the game's person, and is identity when they agree", () => {
  // bed_005: 1.29 m → 49 px for a 64 px person; for an 88 px person that is 67.4.
  assert.equal(+sceneryDrawnPx(49, 64)!.toFixed(3), +((49 * CHARACTER_BODY_PX) / 64).toFixed(3));
  assert.equal(sceneryDrawnPx(49, CHARACTER_BODY_PX), 49, "a piece sized against our own person is drawn verbatim");
  assert.equal(sceneryDrawnPx(49, null), sceneryDrawnPx(49, SCENERY_CONTRACT_CHARACTER_PX), "no contract → the published default");
  assert.equal(sceneryDrawnPx(49, 0), sceneryDrawnPx(49, SCENERY_CONTRACT_CHARACTER_PX), "0 is not a person");
  assert.equal(sceneryDrawnPx(null, 64), null);
  assert.equal(sceneryDrawnPx(0, 64), null);
  assert.equal(sceneryDrawnPx(-3, 64), null);
});

test("CHARACTER_BODY_PX is the measured body of the playable characters, not a guess", () => {
  const policy = JSON.parse(readFileSync(join(GAME_ROOT, "config", "publish.json"), "utf8")) as { playableCharacters?: string[] };
  const heroes = (policy.playableCharacters ?? []).map((p) => join(REPO, "characters2", p, "base", "south.webp")).filter(existsSync);
  if (!heroes.length) return test.skip("characters2 heroes not checked out");
  const heights = heroes.map((f) => {
    const a = imgAlpha(f) as { w: number; h: number; opaque: (x: number, y: number) => boolean };
    let top = a.h, bot = -1;
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (a.opaque(x, y)) { if (y < top) top = y; if (y > bot) bot = y; }
    return bot - top + 1;
  });
  const mean = heights.reduce((s, v) => s + v, 0) / heights.length;
  console.log(`  characterscale: hero bodies ${heights.join("/")} px, mean ${mean.toFixed(1)}, constant ${CHARACTER_BODY_PX}`);
  assert.ok(Math.abs(mean - CHARACTER_BODY_PX) <= 3, `CHARACTER_BODY_PX ${CHARACTER_BODY_PX} drifted from the art (${mean.toFixed(1)}) — re-measure`);
  // And the contract really does assume a shorter person, which is the whole point.
  assert.ok(CHARACTER_BODY_PX > SCENERY_CONTRACT_CHARACTER_PX * 1.2, "the correction is real, not a rounding");
});

test("the collision stamp re-bases exactly as the draw does — the footprint grows with the art", () => {
  const W = 30, H = 30;
  const stamp = (cpx: number) => {
    const rows = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ t: "grass", l: 0 })));
    const grid = buildTerrainGrid(W, H, rows, [], []);
    // k = wph / bboxHeight = 1 at identity, so the ellipse is 40 x 20 screen px.
    const bbox: SceneryBboxDoc = { pieces: { p: { wph: 64, cpx, sprite: "s" } }, boxes: { s: [0, 0, 64, 64, 64, 64] } };
    const hitbox: SceneryHitboxDoc = { "scenery/p": { boxes: [{ ax: 0, ay: -32, rx: 40, ry: 20 }] } };
    stampSceneryCollision(grid, [{ piece: "p", x: 15.5, y: 15.5 }], bbox, hitbox, ISO_GEOMETRY_MAPS3);
    const fp = footprintsInCells(grid, 0, 0, W - 1, H - 1);
    assert.equal(fp.length, 1, "one footprint stamped");
    return fp[0];
  };
  const own = stamp(CHARACTER_BODY_PX); // identity scale
  const contract = stamp(SCENERY_CONTRACT_CHARACTER_PX); // the art is drawn 88/64 larger, so must the footprint be
  const want = CHARACTER_BODY_PX / SCENERY_CONTRACT_CHARACTER_PX;
  console.log(`  characterscale: footprint semi-axes identity ${own.rx.toFixed(3)}x${own.ry.toFixed(3)} screen px, re-based ${contract.rx.toFixed(3)}x${contract.ry.toFixed(3)} (x${want.toFixed(3)})`);
  assert.ok(Math.abs(contract.rx / own.rx - want) < 1e-6, `rx scales by ${want}`);
  assert.ok(Math.abs(contract.ry / own.ry - want) < 1e-6, `ry scales by ${want}`);
  // The published offset (ax, ay) is in FRAME px, so the centre's distance from
  // the placement scales with the art as well — it is the same ellipse on a
  // bigger sprite, not a moved one.
  const dOwn = Math.hypot(own.cx - 15.5, own.cy - 15.5);
  const dContract = Math.hypot(contract.cx - 15.5, contract.cy - 15.5);
  assert.ok(dOwn > 0.01, "the fixture's ay offset puts the centre off the placement");
  assert.ok(Math.abs(dContract / dOwn - want) < 1e-6, `the centre offset scales by ${want} with the art`);
});

test("every published piece in the bbox doc carries its contract character height", () => {
  const doc = JSON.parse(readFileSync(join(GAME_ROOT, "config", "scenery-bbox.json"), "utf8")) as SceneryBboxDoc;
  const pieces = Object.entries(doc.pieces ?? {});
  assert.ok(pieces.length > 100);
  const missing = pieces.filter(([, v]) => typeof v.cpx !== "number" || !(v.cpx! > 0)).map(([k]) => k);
  assert.deepEqual(missing.slice(0, 5), [], `${missing.length} piece(s) without cpx — rerun scripts/build-scenery-bbox.py`);
});

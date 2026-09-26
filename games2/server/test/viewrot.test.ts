// ============================================================================
// THE VIEW TURN'S ROTATION (client/src/viewrot.ts) — the world drawn W, S or E up
// ============================================================================
//
// A turned view is RENDER-ONLY: simulation stays in server space and only what
// is drawn is rotated, so every helper here must be an exact bijection that
// agrees with every other, cell for cell, or the drawn world and the simulated
// one part ways. Four quarter-turns are the identity on the whole document; the
// grid rotation, rotCell, rotPoint/unrotPoint and rotVec/unrotVec agree; a
// facing turns +2 in the 8-ring per quarter-turn; directed scenery that would
// face away is HIDDEN IN PLACE (kept, flagged) so every index still joins the
// server's scenery and footprints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rotateWorldDoc, rotCell, rotPoint, unrotPoint, rotVec, unrotVec, rotDir8, normRot, rotFootprints, type RotateStats } from "../../client/src/viewrot.js";

const WORLD = new URL("../../../maps2/worlds3/the_game/world.json", import.meta.url);

test("a small grid: one quarter-turn clockwise, and back", () => {
  // 3 wide x 2 tall; cell (x,y) -> (H-1-y, x) in a 2 x 3 grid
  const doc = { size: { w: 3, h: 2 }, ground: [[0, 1, 2], [3, 4, 5]], level: [[0, 0, 0], [1, 1, 1]], scenery: [], decks: [], walls: [], ramps: [], rooms: [] };
  const r = rotateWorldDoc(doc, 1);
  assert.deepEqual(r.size, { w: 2, h: 3 });
  assert.deepEqual(r.ground, [[3, 0], [4, 1], [5, 2]]);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    const [nx, ny] = rotCell(x, y, 1, 3, 2);
    assert.equal(r.ground[ny][nx], doc.ground[y][x]);
  }
  assert.equal(rotateWorldDoc(doc, 0), doc, "k = 0 returns the input itself");
});

test("vectors, facings and normRot", () => {
  assert.deepEqual(rotVec(1, 0, 1), [-0, 1]); // +col (screen south-east) -> +row (south-west)
  for (const k of [0, 1, 2, 3] as const) {
    const [x, y] = unrotVec(...rotVec(0.3, -0.7, k), k);
    assert.ok(Math.abs(x - 0.3) < 1e-12 && Math.abs(y + 0.7) < 1e-12);
  }
  assert.equal(rotDir8("south-east", 1), "south-west");
  assert.equal(rotDir8("south-west", 1), "north-west");
  assert.equal(rotDir8("south", 1), "west");
  assert.equal(rotDir8("south", 2), "north");
  assert.equal(rotDir8("not-a-facing", 3), "not-a-facing");
  assert.equal(normRot(-1), 3);
  assert.equal(normRot(5), 1);
});

test("footprints: centres turn as points, an ellipse swaps its axes, a rect turns its angle", () => {
  const f64 = (a: number[]) => Float64Array.from(a);
  const fp = { n: 2, cx: f64([10.5, 20.25]), cy: f64([3.5, 7.75]), rx: f64([6, 8]), ry: f64([3, 4]), p: f64([1, 2]), q: f64([0.5, 0.75]),
    rect: Uint8Array.from([0, 1]), rcos: f64([1, 0.6]), rsin: f64([0, 0.8]), supX: f64([1, 1.5]), supY: f64([0.5, 1.25]) };
  const o = rotFootprints(fp, 1, 50, 40);
  assert.deepEqual([o.cx[0], o.cy[0]], rotPoint(10.5, 3.5, 1, 50, 40));
  assert.deepEqual([o.p[0], o.q[0], o.rx[0], o.ry[0]], [0.5, 1, 3, 6], "ellipse: p<->q and rx<->ry on an odd turn");
  assert.deepEqual([o.p[1], o.q[1]], [2, 0.75], "rect: its own axes are kept");
  assert.ok(Math.abs(o.rcos[1] + 0.8) < 1e-12 && Math.abs(o.rsin[1] - 0.6) < 1e-12, "rect: angle +90 degrees");
  assert.deepEqual([o.supX[1], o.supY[1]], [1.25, 1.5], "supports swap on an odd turn");
  assert.equal(rotFootprints(fp, 0, 50, 40), fp);
});

test("the_game: 4 quarter-turns are the identity; the helpers agree cell for cell; directed scenery is hidden in place", (t) => {
  if (!existsSync(WORLD)) return t.skip("the_game missing (the deploy's test job checks out no world tree)");
  const doc = JSON.parse(readFileSync(WORLD, "utf8"));
  let r: any = doc;
  for (let i = 0; i < 4; i++) r = rotateWorldDoc(r, 1);
  for (const key of ["ground", "level", "decks", "walls", "ramps", "rooms", "spawn", "land"]) assert.deepEqual(r[key], doc[key], `${key} after 4 turns`);
  const W = doc.size.w, H = doc.size.h;
  for (const k of [1, 2, 3] as const) {
    const d = rotateWorldDoc(doc, k);
    let s: any = doc; for (let i = 0; i < k; i++) s = rotateWorldDoc(s, 1);
    assert.deepEqual(s.level, d.level, `k=${k} at once == ${k} single turns`);
    for (let t2 = 0; t2 < 4000; t2++) {
      const x = (t2 * 7919) % W, y = (t2 * 104729) % H;
      const [nx, ny] = rotCell(x, y, k, W, H);
      assert.equal(d.level[ny][nx], doc.level[y][x]);
      assert.equal(d.ground[ny][nx], doc.ground[y][x]);
      const [qx, qy] = rotPoint(x + 0.25, y + 0.75, k, W, H);
      assert.equal(Math.floor(qx), nx); assert.equal(Math.floor(qy), ny); // a point stays in its cell
      const [bx, by] = unrotPoint(qx, qy, k, W, H);
      assert.ok(Math.abs(bx - x - 0.25) < 1e-9 && Math.abs(by - y - 0.75) < 1e-9); // exact inverse
    }
    const st: RotateStats = { hiddenPieces: 0 };
    const v = rotateWorldDoc(doc, k, st);
    assert.equal(v.scenery.length, doc.scenery.length, "no piece is dropped: every index still joins");
    for (const i of st.hiddenIdx ?? []) assert.ok(typeof doc.scenery[i].dir === "string", "only a DIRECTED piece is hidden");
  }
  const st2: RotateStats = { hiddenPieces: 0 };
  rotateWorldDoc(doc, 2, st2);
  assert.equal(st2.hiddenPieces, doc.scenery.filter((p: { dir?: string }) => typeof p.dir === "string").length, "at 180 degrees every directed piece faces away");
});

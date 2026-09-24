// THE TERRAIN BAKE'S PURE PARTS (client/src/terrainbake.ts): chunk math, the
// depth-row segments in the live path's order, the shelf packer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAKE_CHUNK, BAKE_SLOTS, BAKE_U_WRAP, buildSegments, chunkOf, chunksInWindow, packShelves, slotOf, type BakeOp } from "../../client/src/terrainbakecore";

const EPS = 1e-6;
const DY = 14;
const base = (v: number) => 100 + v * DY + DY;

function op(col: number, row: number, i: number, key = "k", w = 64, h = 64, x?: number, y?: number): BakeOp {
  const u = col - row;
  const v = col + row;
  return { key, x: x ?? 1000 + u * 32, y: y ?? 500 + v * DY - i * 15, v, u, i, w, h, role: "face" };
}

test("slotOf is the live path's per-cell seq base: 40 slots a cell, u wrapped at 128, negative u wrapped too", () => {
  assert.equal(slotOf(0), 0);
  assert.equal(slotOf(3), 3 * BAKE_SLOTS);
  assert.equal(slotOf(128), 0);
  assert.equal(slotOf(-2), (BAKE_U_WRAP - 2) * BAKE_SLOTS);
});

test("chunks in a diagonal window cover every cell of it and nothing outside the world", () => {
  // The window u in [-10, 10], v in [20, 40] holds cells with col=(u+v)/2 in [5,25], row=(v-u)/2 in [5,25].
  const cs = chunksInWindow(-10, 10, 20, 40, 100, 100);
  const last = Math.floor(25 / BAKE_CHUNK);
  assert.equal(cs.length, (last + 1) * (last + 1), `${cs.length} chunks for cols 5..25 x rows 5..25`);
  for (let v = 20; v <= 40; v++)
    for (let u = -10; u <= 10; u++) {
      if ((u + v) & 1) continue;
      const [cx, cy] = chunkOf((u + v) / 2, (v - u) / 2);
      assert.ok(cs.some(([a, b]) => a === cx && b === cy), `cell u${u} v${v} in chunk ${cx},${cy} missing`);
    }
  assert.deepEqual(chunksInWindow(300, 400, 300, 400, 100, 100), [], "off the world: no chunk");
  assert.equal(BAKE_CHUNK, 8);
});

test("segments: one per depth row of adjacent cells, ops in (u, i) order, the depth of the first cell's first slot", () => {
  const ops = [op(5, 3, 0), op(5, 3, 1), op(6, 2, 0), op(4, 4, 0), op(7, 1, 0), op(10, 2, 0)];
  // rows: v=8 for (5,3),(6,2),(4,4),(7,1) — u = 2, 4, 0, 6 (adjacent along the row); v=12 for (10,2)
  const segs = buildSegments(ops, base, EPS, 1024, 1024);
  assert.equal(segs.length, 2);
  const a = segs[0];
  assert.equal(a.v, 8);
  assert.deepEqual(a.ops.map((o) => [o.u, o.i]), [[0, 0], [2, 0], [2, 1], [4, 0], [6, 0]]);
  assert.equal(a.u0, 0);
  assert.equal(a.u1, 6);
  assert.equal(a.depth, base(8) + slotOf(0) * EPS);
  assert.equal(a.x0, Math.min(...a.ops.map((o) => o.x)));
  assert.equal(a.y1, Math.max(...a.ops.map((o) => o.y + o.h)));
  assert.equal(segs[1].v, 12);
  assert.equal(segs[1].depth, base(12) + slotOf(8) * EPS);
});

test("a segment breaks at a gap in the row, at the u%128 wrap, and where its box would overflow the atlas", () => {
  // Gap: u = 0, 2 then 8 on the same row.
  const gap = buildSegments([op(3, 3, 0), op(4, 2, 0), op(7, -1, 0)], base, EPS, 1024, 1024);
  assert.deepEqual(gap.map((s) => [s.u0, s.u1]), [[0, 2], [8, 8]]);
  // Wrap: u = 126 then 128 are adjacent cells whose slots restart (the live path's order restarts there too).
  const wrap = buildSegments([op(126, 0, 0), op(127, -1, 0)], base, EPS, 1024, 1024);
  assert.deepEqual(wrap.map((s) => [s.u0, s.u1]), [[126, 126], [128, 128]]);
  // Overflow: cells 33 wide at 32 px apart exceed a 1024 px page; the row splits.
  const wide: BakeOp[] = [];
  for (let k = 0; k < 40; k++) wide.push(op(k, -k, 0));
  const split = buildSegments(wide, base, EPS, 1024, 1024);
  assert.ok(split.length >= 2, `segments ${split.length}`);
  for (const s of split) assert.ok(s.x1 - s.x0 <= 1024, `segment ${s.x1 - s.x0} wide`);
  assert.equal(split.reduce((n, s) => n + s.ops.length, 0), 40, "every op placed once");
});

test("the shelf packer places every segment inside a page without overlap, spills to a second page, and reports what will not fit", () => {
  const segs = buildSegments(
    [op(0, 0, 0, "a", 300, 200), op(2, 0, 0, "b", 500, 100), op(4, 0, 0, "c", 400, 400), op(1, 1, 0, "d", 900, 300), op(6, 0, 0, "e", 700, 700), op(3, 1, 0, "f", 1100, 10)],
    base, EPS, 1024, 1024,
  );
  const pages = packShelves(segs, 1024, 1024, 2);
  assert.ok(pages >= 1 && pages <= 2, `pages ${pages}`);
  const placed = segs.filter((s) => s.page >= 0);
  const unplaced = segs.filter((s) => s.page < 0);
  assert.equal(unplaced.length, 1, "the 1,100 px segment cannot fit a 1,024 px page");
  for (const s of placed) {
    const w = s.x1 - s.x0, h = s.y1 - s.y0;
    assert.ok(s.ax >= 0 && s.ay >= 0 && s.ax + w <= 1024 && s.ay + h <= 1024, `inside the page: ${JSON.stringify([s.ax, s.ay, w, h])}`);
    for (const t of placed) {
      if (t === s || t.page !== s.page) continue;
      const tw = t.x1 - t.x0, th = t.y1 - t.y0;
      const overlap = s.ax < t.ax + tw && t.ax < s.ax + w && s.ay < t.ay + th && t.ay < s.ay + h;
      assert.ok(!overlap, "segments overlap in the atlas");
    }
  }
  // A single page cap: what spills is reported unplaced, never silently dropped.
  const segs2 = buildSegments([op(0, 0, 0, "a", 1000, 600), op(2, 0, 0, "b", 1000, 600)], base, EPS, 1024, 1024);
  const p2 = packShelves(segs2, 1024, 1024, 1);
  assert.equal(p2, 1);
  assert.equal(segs2.filter((s) => s.page < 0).length, 1);
});

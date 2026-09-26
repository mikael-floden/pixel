// CACHE WORLD RENDERING — the rules that decide which ground pictures stand
// (client/src/worldcache.ts). What a screenshot cannot pin: that the tiles
// partition the plane texel by texel, that a cell skips its paint only when
// every tile its art reaches is pictured, that a picture is taken only when the
// scene says its texels are final, and that an edit, a dial, a lost context, a
// turn and the indoor cut each keep a stale picture off the screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WC_PAGE, WC_REACH, WC_TILE, WorldCache, cellUnder, editTiles, tileBoxOf, tileKeyOf, tileMask, tileRangeOfRect,
  type WcFrame, type WcHost, type WcRect, type WcSlot,
} from "../../client/src/worldcache.js";

/** the_game's lattice: DX 32, DY 14, a whole origin. */
const F: WcFrame = { ox: 6336, oy: 10, dx: 32, dy: 14 };

function host(opts: { final?: (tx: number, ty: number) => boolean; pagesPerFrame?: number } = {}) {
  const log = { takes: [] as string[], released: [] as WcSlot[], pages: [] as number[], dropped: [] as number[] };
  let pagesThisFrame = 0;
  const h: WcHost = {
    frame: F,
    final: (tx, ty) => (opts.final ? opts.final(tx, ty) : true),
    addPage: (p) => {
      if (pagesThisFrame >= (opts.pagesPerFrame ?? 99)) return false;
      pagesThisFrame++;
      log.pages.push(p);
      return true;
    },
    take: (tx, ty) => {
      log.takes.push(`${tx},${ty}`);
      return true;
    },
    release: (s) => log.released.push(s),
    dropPage: (p) => log.dropped.push(p),
  };
  return { h, log, frame: () => (pagesThisFrame = 0) };
}

/** A world rectangle covering tiles tx0..tx1 x ty0..ty1 whole. */
function rectOver(tx0: number, tx1: number, ty0: number, ty1: number): WcRect {
  let r: WcRect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const b = tileBoxOf(tx, ty, F);
      r = { x0: Math.min(r.x0, b.x0), y0: Math.min(r.y0, b.y0), x1: Math.max(r.x1, b.x1), y1: Math.max(r.y1, b.y1) };
    }
  return r;
}

test("a tile's box is 512x224 on the_game's lattice, and its mask is exactly its 64 cells' diamonds", () => {
  const b = tileBoxOf(12, 22, F);
  assert.equal(b.x1 - b.x0, 2 * WC_TILE * F.dx);
  assert.equal(b.y1 - b.y0, 2 * WC_TILE * F.dy);
  const { w, h, mask } = tileMask(12, 22, F);
  let on = 0;
  for (const v of mask) on += v;
  // a diamond of 8x8 cells, each dx*dy*2 texels: half the box
  assert.equal(on, (w * h) / 2);
  // every texel of the mask is one of the tile's cells, every other is not
  for (let y = 0; y < h; y += 7)
    for (let x = 0; x < w; x += 5) {
      const [c, r] = cellUnder(b.x0 + x + 0.5, b.y0 + y + 0.5, F);
      const mine = c >= 12 * WC_TILE && c < 13 * WC_TILE && r >= 22 * WC_TILE && r < 23 * WC_TILE;
      assert.equal(mask[y * w + x] === 1, mine, `texel ${x},${y}`);
    }
});

test("the tiles partition the plane: every texel of a region belongs to exactly one tile's mask", () => {
  const counts = new Map<string, number>();
  for (let ty = 20; ty <= 22; ty++)
    for (let tx = 10; tx <= 12; tx++) {
      const b = tileBoxOf(tx, ty, F);
      const { w, mask } = tileMask(tx, ty, F);
      for (let i = 0; i < mask.length; i++) if (mask[i]) {
        const k = `${b.x0 + (i % w)},${b.y0 + Math.floor(i / w)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  for (const [k, n] of counts) assert.equal(n, 1, `texel ${k} in ${n} tiles`);
  // and the middle tile's box is covered whole by the nine masks
  const mid = tileBoxOf(11, 21, F);
  for (let y = mid.y0; y < mid.y1; y += 3) for (let x = mid.x0; x < mid.x1; x += 3) assert.ok(counts.has(`${x},${y}`), `${x},${y} owned`);
});

test("tileRangeOfRect covers every tile whose box meets the rectangle", () => {
  const r = { x0: 7000, y0: 3000, x1: 8400, y1: 4500 };
  const [tx0, tx1, ty0, ty1] = tileRangeOfRect(r, F);
  for (let ty = ty0 - 4; ty <= ty1 + 4; ty++)
    for (let tx = tx0 - 4; tx <= tx1 + 4; tx++) {
      const b = tileBoxOf(tx, ty, F);
      const meets = b.x0 < r.x1 && r.x0 < b.x1 && b.y0 < r.y1 && r.y0 < b.y1;
      if (meets) assert.ok(tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1, `tile ${tx},${ty} meets but is outside the range`);
    }
});

test("a picture is taken only when the scene says its texels are final, nearest the ground's centre first, one a frame", () => {
  const blocked = new Set(["11,21"]);
  const { h, log, frame } = host({ final: (tx, ty) => !blocked.has(`${tx},${ty}`) });
  const wc = new WorldCache(h);
  const ground = rectOver(10, 12, 20, 22);
  wc.step(ground);
  assert.equal(log.takes.length, 1, "one a frame");
  assert.notEqual(log.takes[0], "11,21", "the centre tile is not final: the next nearest goes first");
  for (let i = 0; i < 20; i++) {
    frame();
    wc.step(ground);
  }
  assert.ok(!log.takes.includes("11,21"), "never taken while its texels are not final");
  blocked.clear();
  frame();
  wc.step(ground);
  assert.ok(log.takes.includes("11,21"), "taken once final");
  // only tiles wholly inside the ground texture
  for (const k of log.takes) {
    const [tx, ty] = k.split(",").map(Number);
    const b = tileBoxOf(tx, ty, F);
    assert.ok(b.x0 >= ground.x0 && b.y0 >= ground.y0 && b.x1 <= ground.x1 && b.y1 <= ground.y1, `${k} inside the ground texture`);
  }
});

test("a cell skips its paint only when its tile AND every tile its art reaches are pictured", () => {
  const { h, frame } = host();
  const wc = new WorldCache(h);
  const ground = rectOver(20, 26, 30, 36);
  for (let i = 0; i < 80; i++) {
    frame();
    wc.step(ground);
  }
  const pictured = (tx: number, ty: number) => wc.pictures(tileBoxOf(tx, ty, F)).some((p) => p.box.x0 === tileBoxOf(tx, ty, F).x0 && p.box.y0 === tileBoxOf(tx, ty, F).y0);
  for (let ty = 30; ty <= 36; ty++) for (let tx = 20; tx <= 26; tx++) assert.ok(pictured(tx, ty), `${tx},${ty} pictured`);
  let skips = 0, live = 0;
  for (let ty = 25; ty <= 40; ty++)
    for (let tx = 15; tx <= 31; tx++) {
      const want = pictured(tx, ty) && WC_REACH.every(([dx, dy]) => pictured(tx + dx, ty + dy));
      assert.equal(wc.groundSkips(tx * WC_TILE + 3, ty * WC_TILE + 4), want, `tile ${tx},${ty}`);
      if (want) skips++;
      else live++;
    }
  assert.ok(skips > 0 && live > 0, `both kinds seen (${skips} skip, ${live} live)`);
  // the block's interior skips; its north-west rim (reach -3) and south-east rim (reach +1) do not
  assert.equal(wc.groundSkips(24 * WC_TILE, 34 * WC_TILE), true);
  assert.equal(wc.groundSkips(40 * WC_TILE, 40 * WC_TILE), false, "a tile not pictured never skips");
  assert.ok(WC_REACH.some(([dx, dy]) => dx === -3 && dy === -3) && WC_REACH.some(([dx, dy]) => dx === 1 && dy === 1));
});

test("the pictures a paint draws are the pictured tiles meeting its rect, and none of another orientation or indoors", () => {
  const { h, frame } = host();
  const wc = new WorldCache(h);
  const ground = rectOver(10, 12, 20, 22);
  for (let i = 0; i < 12; i++) {
    frame();
    wc.step(ground);
  }
  const b = tileBoxOf(11, 21, F);
  const pics = wc.pictures({ x0: b.x0 + 10, y0: b.y0 + 10, x1: b.x1 - 10, y1: b.y1 - 10 });
  assert.ok(pics.some((p) => p.box.x0 === b.x0 && p.box.y0 === b.y0), "the tile under the rect");
  assert.ok(pics.every((p) => p.box.x0 < b.x1 - 10 && p.box.x1 > b.x0 + 10), "only tiles meeting it");
  wc.setRot(1);
  assert.equal(wc.pictures(ground).length, 0, "another orientation draws another grid");
  assert.equal(wc.groundSkips(11 * WC_TILE, 21 * WC_TILE), false);
  wc.setRot(0);
  assert.ok(wc.pictures(ground).length > 0, "turned back: the pictures stand again");
  wc.suspend(true);
  assert.equal(wc.pictures(ground).length, 0, "indoors the cut rewrites columns: nothing stands");
  frame();
  const before = wc.stats.taken;
  wc.step(rectOver(0, 3, 0, 3));
  assert.equal(wc.stats.taken, before, "and nothing is taken");
});

test("an edit lets go of every tile it can change and every tile their art reaches; a dial lets go of all", () => {
  const { h, frame } = host();
  const wc = new WorldCache(h);
  const ground = rectOver(0, 9, 0, 9);
  for (let i = 0; i < 200; i++) {
    frame();
    wc.step(ground);
  }
  const pictured = (tx: number, ty: number) => wc.pictures(tileBoxOf(tx, ty, F)).some((p) => p.box.x0 === tileBoxOf(tx, ty, F).x0 && p.box.y0 === tileBoxOf(tx, ty, F).y0);
  const before = new Set<string>();
  for (let ty = -3; ty <= 12; ty++) for (let tx = -3; tx <= 12; tx++) if (pictured(tx, ty)) before.add(`${tx},${ty}`);
  for (let ty = 0; ty <= 9; ty++) for (let tx = 0; tx <= 9; tx++) assert.ok(before.has(`${tx},${ty}`));
  const [tx0, tx1, ty0, ty1] = editTiles(40, 40); // the 24-cell region 24..47 and 34..46: tiles 3..5
  assert.deepEqual([tx0, tx1, ty0, ty1], [3, 5, 3, 5]);
  const n = wc.dirtyEdit(40, 40);
  // tiles 3..5 and where their art reaches ([-3..1]): 0..6 x 0..6
  let gone = 0;
  for (const k of before) {
    const [tx, ty] = k.split(",").map(Number);
    const hit = tx >= 0 && tx <= 6 && ty >= 0 && ty <= 6;
    assert.equal(pictured(tx, ty), !hit, `tile ${k}`);
    if (hit) gone++;
  }
  assert.equal(n, gone);
  wc.flush();
  assert.equal(wc.size, 0);
});

test("the cap: pages are allocated one a frame when the host allows, and past the cap the least recently used far tile gives its slot", () => {
  const perPage = Math.floor(WC_PAGE / 512) * Math.floor(WC_PAGE / 224);
  assert.equal(perPage, 8);
  const { h, log, frame } = host({ pagesPerFrame: 1 });
  const cap = 2 * WC_PAGE * WC_PAGE * 4; // two pages, 16 pictures
  const wc = new WorldCache(h, cap);
  const a = rectOver(0, 3, 0, 3); // 16 tiles
  for (let i = 0; i < 40; i++) {
    frame();
    wc.step(a);
  }
  assert.equal(wc.size, 16);
  assert.deepEqual(log.pages, [0, 1]);
  // move far away: new tiles take the slots of the least recently used far ones
  const b = rectOver(40, 41, 40, 41);
  for (let i = 0; i < 10; i++) {
    frame();
    wc.step(b);
  }
  assert.equal(wc.size, 16, "never past the cap");
  assert.equal(log.pages.length, 2, "no third page");
  assert.ok(log.released.length >= 4, "far pictures gave their slots");
  assert.ok(wc.pictures(b).length >= 4, "the new place is pictured");
});

test("a lost context lets every picture and page go; the button going off does the same", () => {
  const { h, log, frame } = host();
  const wc = new WorldCache(h);
  for (let i = 0; i < 20; i++) {
    frame();
    wc.step(rectOver(0, 3, 0, 3));
  }
  assert.ok(wc.size > 0);
  wc.contextLost();
  assert.equal(wc.size, 0);
  assert.equal(wc.take().pages, 0);
  assert.equal(log.dropped.length, log.pages.length, "every page it allocated");
  assert.equal(tileKeyOf(0, 5, 6) !== tileKeyOf(1, 5, 6), true, "orientations never share a key");
});

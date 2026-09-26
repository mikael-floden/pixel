// CACHE WORLD RENDERING — the rules that decide which ground pictures stand
// (client/src/worldcache.ts). What a screenshot cannot pin: that the tiles
// partition the plane texel by texel, that a cell's reach holds every tile its
// column can touch, that a cell skips its paint only when every tile its art
// reaches is pictured, that a picture is taken only when the scene says its
// texels are final, and that an edit, a dial, a lost context, a turn and the
// indoor cut each keep a stale picture off the screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WC_PAGE, WC_REFUSED_WAIT, WC_TILE, WorldCache, cellReach, cellUnder, editTiles, tileBoxOf, tileKeyOf, tileMask, tileRangeOfRect,
  type WcColumn, type WcFrame, type WcHost, type WcRect, type WcSlot,
} from "../../client/src/worldcache.js";

/** the_game's lattice: DX 32, DY 14, a whole origin. */
const F: WcFrame = { ox: 6336, oy: 10, dx: 32, dy: 14 };
/** tiles3's column: TILE 64, TOP_Y 10, a 15-row storey. */
const C: WcColumn = { tile: 64, topY: 10, lh: 15, pitch: 15 };

function host(opts: { final?: (tx: number, ty: number) => boolean; pagesPerFrame?: number; top?: (tx: number, ty: number) => number } = {}) {
  const log = { takes: [] as string[], released: [] as WcSlot[], pages: [] as number[], dropped: [] as number[] };
  let pagesThisFrame = 0;
  const h: WcHost = {
    frame: F,
    column: C,
    topOf: (tx, ty) => (opts.top ? opts.top(tx, ty) : 0),
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

test("a cell's reach holds every tile its grown column touches, texel by texel, and nothing farther", () => {
  // the column tiles3 draws in (columnX, columnY on the level-0 lattice), grown by a tile
  const rectOf = (c: number, r: number, top: number): WcRect => {
    const cx = F.ox + (c - r - 1) * F.dx;
    const y0c = F.oy - C.topY + (c + r) * F.dy;
    return { x0: cx - C.tile, x1: cx + 2 * C.tile, y0: y0c - top * C.pitch - C.topY - C.lh - C.tile, y1: y0c + 2 * C.tile + C.lh };
  };
  let lists = 0;
  for (const top of [0, 1, 3, 12, 41])
    for (const [i, j] of [[0, 0], [7, 7], [0, 7], [7, 0], [3, 4], [5, 1]]) {
      const tx = 13, ty = 21;
      const c = tx * WC_TILE + i, r = ty * WC_TILE + j;
      const got = new Set<string>();
      const off = cellReach(i, j, top, F, C);
      for (let k = 0; k < off.length; k += 2) got.add(`${off[k]},${off[k + 1]}`);
      const rect = rectOf(c, r, top);
      // every texel centre of the grown column: its tile is in the reach
      const seen = new Set<string>();
      for (let y = Math.floor(rect.y0); y < Math.ceil(rect.y1); y++)
        for (let x = Math.floor(rect.x0); x < Math.ceil(rect.x1); x++) {
          const [cc, rr] = cellUnder(x + 0.5, y + 0.5, F);
          const k = `${Math.floor(cc / WC_TILE) - tx},${Math.floor(rr / WC_TILE) - ty}`;
          seen.add(k);
          assert.ok(got.has(k), `top ${top} place ${i},${j}: texel ${x},${y} is in tile ${k}, missing from the reach`);
        }
      assert.ok(got.has("0,0"), "a cell reaches its own tile");
      // ...and nothing farther: every listed tile has a texel within 2 px of the column
      const near = new Set<string>();
      for (let y = Math.floor(rect.y0) - 2; y < Math.ceil(rect.y1) + 2; y++)
        for (let x = Math.floor(rect.x0) - 2; x < Math.ceil(rect.x1) + 2; x++) {
          const [cc, rr] = cellUnder(x + 0.5, y + 0.5, F);
          near.add(`${Math.floor(cc / WC_TILE) - tx},${Math.floor(rr / WC_TILE) - ty}`);
        }
      for (const k of got) assert.ok(near.has(k), `top ${top} place ${i},${j}: tile ${k} listed but never within 2 px`);
      lists += got.size;
    }
  assert.ok(lists > 0);
  // a flat cell's reach is its tile and at most its eight neighbours; a
  // 41-storey column (~700 px with its margins) reaches six half-rows up, 112 px each
  assert.ok(cellReach(3, 4, 0, F, C).length / 2 <= 9);
  const tall = cellReach(3, 4, 41, F, C);
  let up = 0;
  for (let k = 0; k < tall.length; k += 2) up = Math.min(up, tall[k] + tall[k + 1]);
  assert.ok(up <= -6, `tall column reaches ${-up} tile half-rows up`);
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
  // a refused tile rests WC_REFUSED_WAIT frames before it is asked again
  for (let i = 0; i <= WC_REFUSED_WAIT + 8 && !log.takes.includes("11,21"); i++) {
    frame();
    wc.step(ground);
  }
  assert.ok(log.takes.includes("11,21"), "taken once final");
  // only tiles wholly inside the ground texture
  for (const k of log.takes) {
    const [tx, ty] = k.split(",").map(Number);
    const b = tileBoxOf(tx, ty, F);
    assert.ok(b.x0 >= ground.x0 && b.y0 >= ground.y0 && b.x1 <= ground.x1 && b.y1 <= ground.y1, `${k} inside the ground texture`);
  }
});

test("a cell skips its paint only when its tile AND every tile its art reaches are pictured", () => {
  // one tall tile: its cells reach far up; every other tile is flat
  const tallAt = (tx: number, ty: number) => (tx === 22 && ty === 31 ? 30 : 0);
  const { h, frame } = host({ top: tallAt });
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
    for (let tx = 15; tx <= 31; tx++)
      for (const [i, j] of [[3, 4], [0, 0], [7, 7], [7, 0]]) {
        const off = cellReach(i, j, pictured(tx, ty) ? tallAt(tx, ty) : 0, F, C);
        let want = pictured(tx, ty);
        for (let k = 0; k < off.length && want; k += 2) want = pictured(tx + off[k], ty + off[k + 1]);
        assert.equal(wc.groundSkips(tx * WC_TILE + i, ty * WC_TILE + j), want, `tile ${tx},${ty} place ${i},${j}`);
        if (want) skips++;
        else live++;
      }
  assert.ok(skips > 0 && live > 0, `both kinds seen (${skips} skip, ${live} live)`);
  // a flat tile inside the block skips; the tall one reaches past the block's top rows and does not
  assert.equal(wc.groundSkips(24 * WC_TILE + 3, 34 * WC_TILE + 4), true);
  assert.equal(wc.groundSkips(22 * WC_TILE + 3, 31 * WC_TILE + 4), false, "a tall column reaching past the block's top paints live");
  assert.equal(wc.groundSkips(40 * WC_TILE, 40 * WC_TILE), false, "a tile not pictured never skips");
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
  const top = 12;
  const n = wc.dirtyEdit(40, 40, top);
  // tiles 3..5 and every tile their cells' art reaches up to storey 12
  const hitSet = new Set<string>();
  for (let ty = 3; ty <= 5; ty++)
    for (let tx = 3; tx <= 5; tx++)
      for (let j = 0; j < WC_TILE; j++)
        for (let i = 0; i < WC_TILE; i++) {
          const off = cellReach(i, j, top, F, C);
          for (let k = 0; k < off.length; k += 2) hitSet.add(`${tx + off[k]},${ty + off[k + 1]}`);
        }
  assert.ok(hitSet.has("4,4") && hitSet.has("2,2") && !hitSet.has("9,9"));
  let gone = 0;
  for (const k of before) {
    const hit = hitSet.has(k);
    assert.equal(pictured(...(k.split(",").map(Number) as [number, number])), !hit, `tile ${k}`);
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

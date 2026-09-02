// ============================================================================
// SCENERY3 — where 1,388 pieces stand, proven against render3's own pastes
// ============================================================================
//
// A maps3 world places scenery at CONTINUOUS cell coordinates and names only a
// directory. client/src/scenery3.ts turns that into a sprite a scene can draw,
// and the failure mode is the same one tiles3 has: everything renders, nothing
// throws, and the whole map is half a tile off. An integer (x,y) projects to a
// cell diamond's NORTH vertex, not its centre; the art is cropped to its opaque
// bbox BEFORE it is scaled; the flip happens AFTER the scale and about the
// CROP's centre; the rounding is Python's half-to-even. Get any one of those
// wrong and 1,388 pieces sit consistently, plausibly, in the wrong place.
//
// So the anchor maths is checked against render3's OWN paste positions: the
// parity fixture records 24 placements from the bay window with the bbox it
// cropped, the size it scaled to and the (sx, sy) it pasted at. Those numbers
// came out of render3.py, not out of this port.
//
// SKIPPED, NOT FAILED, WHEN THE DATA IS ABSENT — the deploy workflow's test job
// sparse-checks-out games2 + characters2 + maps2/worlds + live, so neither
// maps2/worlds3 nor scenery/ is there. Same guard as tiles3.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isoFrame, viewFromDoc, DX, DY } from "../../client/src/tiles3";
import {
  parsePiece,
  litState,
  stateFor,
  southSprite,
  alphaBBox,
  fitSprite,
  frameRect,
  anchorX,
  anchorY,
  anchorCell,
  inBounds,
  roofedCells,
  buildPlacements,
  distinctPieces,
  sceneryLoads,
  manifestPath,
  manifestUrl,
  artPath,
  artUrl,
  artKey,
  SceneryIndex,
  SceneryPieces,
  MAX_ART_PX,
  type SceneryPiece,
} from "../../client/src/scenery3";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const FIXTURE = join(HERE, "fixtures", "tiles3-parity.json");
const rel = (p: string) => join(REPO, p);
const NEEDS = ["maps2/worlds3/the_game/world.json", "scenery/trees/tree_021/scenery.json"];
const MISSING = [FIXTURE, ...NEEDS.map(rel)].filter((p) => !existsSync(p));
const skip = !!MISSING.length;

const F: any = skip ? null : JSON.parse(readFileSync(FIXTURE, "utf8"));
const doc: any = skip ? null : JSON.parse(readFileSync(rel(F.world.path), "utf8"));
const px = (p: string) => {
  const { width, height, data } = imgRGBA(rel(p)) as { width: number; height: number; data: Uint8Array };
  return { w: width, h: height, data: data as unknown as Uint8ClampedArray };
};
const manifest = (id: string) => JSON.parse(readFileSync(rel(`scenery/${id}/scenery.json`), "utf8"));

/* -- THE PROOF: render3's own paste positions -------------------------------- */

test("every fixture placement lands on render3's pixel", { skip }, () => {
  const W = F.windows[0];
  const bounds = { x0: W.x0, y0: W.y0, x1: W.x1, y1: W.y1 };
  const view = viewFromDoc(doc, bounds);
  const frame = isoFrame(bounds, view.maxLevel, W.origin.storey_pitch);
  // The fixture's own origin is what render3 derived. If the frame disagrees,
  // every placement below is measured against the wrong canvas.
  assert.equal(frame.ox, W.origin.ox);
  assert.equal(frame.oy, W.origin.oy);

  let checked = 0;
  for (const s of W.scenery) {
    const meta = manifest(s.piece);
    const piece = parsePiece(s.piece, meta);
    assert.ok(piece, `${s.piece} parsed`);
    const st = stateFor(piece!, s.lit);
    const sprite = southSprite(st);
    // The fixture names the file render3 opened — the port must reach the same
    // one through the manifest, not by convention.
    assert.equal(artPath(sprite), F.paths[s.sprite], `${s.piece} sprite`);

    const img = px(artPath(sprite));
    const bbox = alphaBBox(img);
    assert.deepEqual(bbox, s.bbox, `${s.piece} bbox`);

    const want = piece!.worldPxHeight ?? img.h;
    assert.equal(want, s.want_h, `${s.piece} world_px_height`);

    const [cx, cy] = anchorCell(s);
    const level = view.levelAt(cx, cy);
    const fit = fitSprite(
      bbox,
      img,
      want,
      anchorX(frame, s.x, s.y),
      anchorY(frame, s.x, s.y, level),
      s.hflip,
    );
    assert.equal(fit.w, s.w, `${s.piece} scaled w`);
    assert.equal(fit.h, s.h, `${s.piece} scaled h`);
    assert.equal(fit.x, s.sx, `${s.piece} paste x`);
    assert.equal(fit.y, s.sy, `${s.piece} paste y`);
    assert.equal(fit.flipX, s.hflip, `${s.piece} hflip`);
    checked++;
  }
  assert.equal(checked, 24);
});

test("the anchor is the cell's NORTH vertex, and (x+.5,y+.5) is its centre", { skip }, () => {
  const bounds = { x0: 0, y0: 0, x1: 8, y1: 8 };
  const frame = isoFrame(bounds, 0, 15);
  // The diamond's apex row is where a tile's 64-box row TOP_Y lands, which is
  // columnY; its centre is DY below that and DX right of the box's left edge.
  const ax = anchorX(frame, 3, 5);
  const ay = anchorY(frame, 3, 5, 0);
  const cxy = { x: anchorX(frame, 3.5, 5.5), y: anchorY(frame, 3.5, 5.5, 0) };
  assert.equal(cxy.x, ax, "the centre is directly below the apex");
  assert.equal(cxy.y, ay + DY, "the centre is DY below the apex");
  // A step of one cell in x moves +DX right and +DY down; in y, -DX and +DY.
  assert.equal(anchorX(frame, 4, 5) - ax, DX);
  assert.equal(anchorY(frame, 4, 5, 0) - ay, DY);
  assert.equal(anchorX(frame, 3, 6) - ax, -DX);
  assert.equal(anchorY(frame, 3, 6, 0) - ay, DY);
  // Elevation lifts by the MEASURED pitch, not by WALL.
  assert.equal(anchorY(frame, 3, 5, 4) - ay, -60);
});

test("a piece stands on the terrain column, not beside it", { skip }, () => {
  // render3 lifts scenery by `z * LP` — the MEASURED pitch (15), the same one
  // its terrain columns stack at, never WALL (17). On the bay's 7-storey cliffs
  // that is a 14px error per column, so it is checked against the fixture's own
  // cell origins rather than restated: the anchor of a placement standing on a
  // cell must BE that cell's column origin, shifted to the diamond's centre.
  const W = F.windows[0];
  const bounds = { x0: W.x0, y0: W.y0, x1: W.x1, y1: W.y1 };
  const frame = isoFrame(bounds, viewFromDoc(doc, bounds).maxLevel, W.origin.storey_pitch);
  const byCell = new Map<string, any>(W.cells.map((c: any) => [`${c.x},${c.y}`, c]));
  let raised = 0;
  for (const s of W.scenery) {
    const [cx, cy] = anchorCell(s);
    const cell = byCell.get(`${cx},${cy}`);
    if (!cell) continue;
    assert.equal(anchorX(frame, cx, cy), cell.sx + DX, `${s.piece} column x`);
    assert.equal(anchorY(frame, cx, cy, cell.z), cell.sy, `${s.piece} column y`);
    if (cell.z > 0) raised++;
  }
  assert.ok(raised > 0, "and some of them stand on raised ground");
  assert.notEqual(W.origin.storey_pitch, 17, "the pitch is measured, not WALL");
});

/* -- the fit ---------------------------------------------------------------- */

test("crop, scale, flip, paste — in render3's order and nobody else's", { skip }, () => {
  const canvas = { w: 192, h: 192 };
  const bbox: [number, number, number, number] = [21, 5, 169, 187];
  const fit = fitSprite(bbox, canvas, 186, 1000, 500, false);
  assert.deepEqual([fit.sx, fit.sy, fit.sw, fit.sh], [21, 5, 148, 182]);
  assert.equal(fit.h, 186);
  assert.equal(fit.w, 151); // rint(148 * 186/182)
  assert.equal(fit.x, 924); // trunc(1000 - 151/2) = trunc(924.5), NOT round
  assert.equal(fit.y, 500 - 186);

  // THE FLIP IS ABOUT THE CROP, NOT THE CANVAS: mirroring the full 192 canvas
  // instead moves this piece 16px sideways, and the whole forest with it.
  const flipped = fitSprite(bbox, canvas, 186, 1000, 500, true);
  assert.equal(flipped.x, fit.x, "a flip does not move the destination box");
  assert.equal(flipped.w, fit.w);
  assert.equal(flipped.flipX, true);
});

test("the scale rounds HALF TO EVEN, the way Python does", { skip }, () => {
  // 5 x 10 art scaled to height 11 -> width 5.5, which half-up would call 6.
  const fit = fitSprite([0, 0, 5, 10], { w: 16, h: 16 }, 11, 0, 0, false);
  assert.equal(fit.h, 11);
  assert.equal(fit.w, 6, "5.5 -> 6 (nearest even)");
  const fit2 = fitSprite([0, 0, 7, 10], { w: 16, h: 16 }, 5, 0, 0, false);
  assert.equal(fit2.w, 4, "3.5 -> 4 (nearest even)");
  const fit3 = fitSprite([0, 0, 5, 10], { w: 16, h: 16 }, 5, 0, 0, false);
  assert.equal(fit3.w, 2, "2.5 -> 2 (nearest even, NOT 3)");
});

test("the paste truncates toward zero, and a 1px piece never vanishes", { skip }, () => {
  const fit = fitSprite([0, 0, 4, 4], { w: 8, h: 8 }, 4, 10.9, 20.9, false);
  assert.equal(fit.x, 8); // trunc(10.9 - 2)
  assert.equal(fit.y, 16); // trunc(20.9 - 4)
  // A water lily is scaled to 5px tall out of a 41px bbox; a piece that rounds
  // to zero would disappear rather than draw one pixel.
  const tiny = fitSprite([0, 0, 100, 100], { w: 128, h: 128 }, 1, 0, 0, false);
  assert.equal(tiny.w, 1);
  assert.equal(tiny.h, 1);
});

test("a fully transparent sprite falls back to its whole canvas", { skip }, () => {
  assert.equal(alphaBBox({ w: 4, h: 4, data: new Uint8ClampedArray(64) }), null);
  const fit = fitSprite(null, { w: 64, h: 64 }, null, 0, 0, false);
  assert.deepEqual([fit.sx, fit.sy, fit.sw, fit.sh], [0, 0, 64, 64]);
  assert.equal(fit.h, 64, "no world_px_height falls back to the canvas height");
});

test("alphaBBox is PIL's getbbox on every sprite the fixture uses", { skip }, () => {
  // The port is alpha-only; PIL's is any-channel, and `exact=True` WebP keeps
  // RGB under transparent pixels. Measured equal on all 712 published sprites;
  // the 20 distinct ones here are the part the fixture can prove independently.
  const seen = new Set<string>();
  for (const s of F.windows[0].scenery) {
    const p = F.paths[s.sprite];
    if (seen.has(p)) continue;
    seen.add(p);
    assert.deepEqual(alphaBBox(px(p)), s.bbox, p);
  }
  assert.equal(seen.size, 20);
});

/* -- animation registration -------------------------------------------------- */

test("an animation frame draws its WHOLE canvas under the still's transform", { skip }, () => {
  const canvas = { w: 192, h: 192 };
  const fit = fitSprite([21, 5, 169, 187], canvas, 186, 1000, 500, false);
  const r = frameRect(fit, canvas, canvas)!;
  assert.ok(r, "same canvas registers");
  // The pixel that was at the crop's top-left is still at the crop's top-left.
  assert.equal(r.x + fit.sx * fit.kx, fit.x);
  assert.equal(r.y + fit.sy * fit.ky, fit.y);
  // And the crop's own extent inside it is exactly the still's box.
  assert.equal(r.w * (fit.sw / canvas.w), fit.w);

  // Flipped, the canvas mirrors about the SAME axis the still uses: the crop's
  // right edge maps to the crop's left edge.
  const ff = fitSprite([21, 5, 169, 187], canvas, 186, 1000, 500, true);
  const fr = frameRect(ff, canvas, canvas)!;
  assert.equal(fr.x + fr.w - ff.sx * ff.kx, ff.x + ff.w);
});

test("a frame on a different canvas than its still is REFUSED, not guessed", { skip }, () => {
  const canvas = { w: 64, h: 64 };
  const fit = fitSprite([9, 3, 56, 62], canvas, 59, 100, 100, false);
  assert.equal(frameRect(fit, canvas, { w: 68, h: 68 }), null);
  assert.ok(frameRect(fit, canvas, canvas));
  // The real case: crystal_tree_002 ships 68x68 wind frames for a 64x64 still,
  // and the_game places it. It must draw static, not 4px adrift.
  const p = parsePiece("crystal_trees/crystal_tree_002", manifest("crystal_trees/crystal_tree_002"))!;
  const st = stateFor(p, false);
  const wind = st.anims.wind;
  assert.ok(wind, "the still's state carries the wind clip");
  const still = px(artPath(st.sprite));
  const frame = px(artPath(wind.frames[0]));
  assert.notEqual(frame.w, still.w);
  const f2 = fitSprite(alphaBBox(still), still, p.worldPxHeight, 0, 0, false);
  assert.equal(frameRect(f2, still, frame), null);
});

/* -- the manifest, in every shape it currently has --------------------------- */

test("animations are found under the STATES (the new placement)", { skip }, () => {
  const p = parsePiece("trees/tree_021", manifest("trees/tree_021"))!;
  assert.equal(p.sprite, "trees/tree_021/sprite.webp");
  assert.equal(p.worldPxHeight, 186);
  assert.equal(p.baseState, "NOT_LIT_1", "the state whose sprite IS the piece sprite");
  const base = stateFor(p, false);
  assert.equal(base.sprite, p.sprite);
  assert.equal(base.anims.wind.frames.length, 5);
  assert.equal(base.anims.wind.frames[0], "trees/tree_021/animations/wind/00.webp");
  assert.equal(base.anims.wind.keepFirstFrame, true);
  // A lit placement takes the first LIT_* state and ITS clip, from ITS folder.
  assert.equal(litState(p), "LIT_1");
  const lit = stateFor(p, true);
  assert.equal(lit.sprite, "trees/tree_021/lit_1/sprite.webp");
  assert.equal(lit.anims.wind.frames[0], "trees/tree_021/lit_1/animations/wind/00.webp");
});

test("animations still on the PIECE (the old placement) land on the base state", { skip }, () => {
  const legacy = {
    sprite: "g/p/sprite.webp",
    placement: { world_px_height: 40 },
    animations: {
      wind: { frame_paths: ["g/p/animations/wind/00.webp"], strip: "g/p/animations/wind__strip.webp", frame_count: 5 },
    },
    states: { NOT_LIT_1: { sprite: "g/p/sprite.webp" }, LIT_1: { sprite: "g/p/lit_1/sprite.webp" } },
  };
  const p = parsePiece("g/p", legacy)!;
  assert.equal(stateFor(p, false).anims.wind.frames.length, 1);
  assert.equal(stateFor(p, true).anims.wind, undefined, "the lit state has none of its own");
  // With NO states at all the piece still resolves through one shape.
  const bare = parsePiece("g/q", { sprite: "g/q/sprite.webp", animations: legacy.animations })!;
  assert.equal(bare.baseState, "");
  assert.equal(stateFor(bare, false).sprite, "g/q/sprite.webp");
  assert.equal(stateFor(bare, false).anims.wind.frameCount, 5);
});

test("SOUTH is picked when a piece offers facings — including with no south key", { skip }, () => {
  const w4 = parsePiece("windows/window_004", manifest("windows/window_004"))!;
  const off = stateFor(w4, false);
  assert.equal(southSprite(off), "windows/window_004/sprite.webp");
  assert.ok(off.rotations["south-east"], "the facings are carried, just not chosen");
  assert.equal(w4.lightsOn, "LIGHTS_ON");
  assert.equal(litState(w4), null, "LIGHTS_ON does not start with LIT — render3's rule");
  assert.equal(stateFor(w4, true).sprite, off.sprite, "so a lit placement draws the same still");
  assert.equal(w4.hflipOk, false, "a facing piece must never be mirrored");
  assert.equal(southSprite(stateFor(w4, false, "LIGHTS_ON")), "windows/window_004/lights_on/sprite.webp");

  // The 14 states mid-generation that publish SE/SW and no south: their own
  // sprite IS the south still, and a south draw must never get a south-east.
  const partial = parsePiece("g/p", {
    sprite: "g/p/sprite.webp",
    states: {
      LIGHTS_ON: {
        sprite: "g/p/lights_on/sprite.webp",
        rotations: { "south-east": "g/p/lights_on/rotations/south-east.webp" },
      },
      LIGHTS_OFF: { sprite: "g/p/sprite.webp" },
    },
  })!;
  assert.equal(southSprite(stateFor(partial, false, "LIGHTS_ON")), "g/p/lights_on/sprite.webp");
});

test("every published manifest parses, and every piece the world places resolves", { skip }, () => {
  const warns: string[] = [];
  let pieces = 0;
  let withAnim = 0;
  for (const g of readdirSync(rel("scenery"), { withFileTypes: true })) {
    if (!g.isDirectory()) continue;
    for (const d of readdirSync(rel(`scenery/${g.name}`), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const id = `${g.name}/${d.name}`;
      if (!existsSync(rel(manifestPath(id)))) continue;
      const p = parsePiece(id, manifest(id), (m) => warns.push(m));
      assert.ok(p, `${id} parses`);
      pieces++;
      // Every art path the piece names must exist, or the game 404s at draw.
      for (const st of Object.values(p!.states)) {
        assert.ok(existsSync(rel(artPath(southSprite(st)))), `${id}#${st.key} sprite exists`);
        for (const a of Object.values(st.anims)) {
          withAnim++;
          for (const f of a.frames) assert.ok(existsSync(rel(artPath(f))), `${id} ${a.name} frame`);
        }
      }
    }
  }
  assert.equal(warns.length, 0, `manifests parsed with no surprises:\n${warns.join("\n")}`);
  assert.ok(pieces >= 700, `${pieces} pieces`);
  assert.ok(withAnim >= 1000, `${withAnim} state animations`);
});

test("a broken manifest degrades, once, and never throws", { skip }, () => {
  const warns: string[] = [];
  const w = (m: string) => warns.push(m);
  assert.equal(parsePiece("g/p", null, w), null);
  assert.equal(parsePiece("g/p", { states: {} }, w), null, "no sprite is the only fatal shape");
  const p = parsePiece(
    "g/p",
    {
      sprite: "g/p/sprite.webp",
      placement: "not an object",
      states: { A: 7, B: { sprite: "" }, C: { sprite: "g/p/c.webp", animations: { x: { frame_paths: [] } } } },
      animations: [1, 2, 3],
      rotations: "nope",
      unknown_field_from_the_future: { deeply: { nested: true } },
    },
    w,
  )!;
  assert.ok(p);
  assert.equal(p.worldPxHeight, null);
  assert.deepEqual(Object.keys(p.states), ["C", ""], "the bad states are dropped, the still is added");
  assert.equal(stateFor(p, false).sprite, "g/p/sprite.webp");
  assert.equal(warns.length, 5, "two fatal manifests + three ignored sub-objects");

  // `__proto__` is a real own property of a JSON object, and assigning it on an
  // object literal sets the PROTOTYPE — a state named that must be dropped, not
  // installed.
  const evil = parsePiece(
    "g/p",
    { sprite: "g/p/sprite.webp", states: JSON.parse('{"__proto__":{"sprite":"x"},"A":{"sprite":"g/p/a.webp"}}') },
    w,
  )!;
  assert.deepEqual(Object.keys(evil.states).sort(), ["", "A"]);
  assert.equal(({} as any).sprite, undefined, "Object.prototype is intact");
});

/* -- placements and the window ----------------------------------------------- */

test("placements drop what render3 drops, and keep its painter order", { skip }, () => {
  const W = F.windows[0];
  const bounds = { x0: W.x0, y0: W.y0, x1: W.x1, y1: W.y1 };
  const view = viewFromDoc(doc, bounds);
  const frame = isoFrame(bounds, view.maxLevel, W.origin.storey_pitch);
  const all = buildPlacements(doc.scenery, {
    frame,
    levelAt: view.levelAt,
    roofed: roofedCells(doc.decks, doc.size.w),
    width: doc.size.w,
    bounds,
  });
  // render3 draws an OVERVIEW from above, so its survivors are the unroofed
  // ones; the index keeps the roofed pieces for the cut-away to show.
  const ps = all.filter((p) => !p.roofed);
  assert.equal(ps.length, W.scenery.length, "same survivors as render3");
  for (let i = 0; i < ps.length; i++) {
    assert.equal(ps[i].piece, W.scenery[i].piece, `#${i} piece`);
    assert.equal(ps[i].x, W.scenery[i].x);
    assert.equal(ps[i].y, W.scenery[i].y);
    assert.equal(ps[i].hflip, W.scenery[i].hflip);
    if (i) assert.ok(ps[i].sort >= ps[i - 1].sort, "sorted by x+y");
  }
});

test("a roof or a cave FLAGS a piece; a bridge does not", { skip }, () => {
  const decks = [
    { kind: "roof", cells: [{ x: 1, y: 1 }] },
    { kind: "cave", cells: [{ col: 2, row: 2 }] },
    { kind: "bridge", cells: [{ x: 3, y: 3 }] },
  ];
  const r = roofedCells(decks, 10);
  assert.deepEqual([...r].sort((a, b) => a - b), [11, 22]);
  const frame = isoFrame({ x0: 0, y0: 0, x1: 8, y1: 8 }, 0, 15);
  const ps = buildPlacements(
    [
      { piece: "a/1", x: 1.5, y: 1.5 },
      { piece: "a/2", x: 2.5, y: 2.5 },
      { piece: "a/3", x: 3.5, y: 3.5 },
      { piece: "", x: 4.5, y: 4.5 },
      { piece: "a/5", x: NaN, y: 1 },
    ],
    { frame, levelAt: () => 0, roofed: r, width: 10 },
  );
  // KEPT AND FLAGGED, not dropped: the roofed pieces are the interiors'
  // furniture, and a cut-away shows them (WorldScene.roofCutAwayAt). render3's
  // own survivor set is `!roofed`.
  assert.deepEqual(ps.map((p) => p.piece), ["a/1", "a/2", "a/3"]);
  assert.deepEqual(ps.map((p) => !!p.roofed), [true, true, false], "the roof and the cave flag; the bridge does not");
  assert.deepEqual(ps.filter((p) => !p.roofed).map((p) => p.piece), ["a/3"], "render3's set");
  assert.deepEqual(ps.map((p) => p.i), [0, 1, 2], "the world index survives");
  assert.deepEqual(ps.map((p) => p.order), [0, 1, 2], "painter order stays monotone across the flagged ones");
  assert.ok(!("roofed" in ps[2]), "an unroofed placement carries no flag at all");
  // Malformed entries are still DROPPED — a piece with no id or no position
  // cannot be drawn by anything, roof or no roof.
  assert.equal(ps.length, 3, "the empty id and the NaN coordinate are gone");
});

test("with no roofed set every placement is unflagged (a world with no roof deck)", { skip }, () => {
  const frame = isoFrame({ x0: 0, y0: 0, x1: 8, y1: 8 }, 0, 15);
  const ps = buildPlacements([{ piece: "a/1", x: 1.5, y: 1.5 }], { frame, levelAt: () => 0 });
  assert.equal(ps.length, 1);
  assert.ok(!("roofed" in ps[0]));
});

test("the whole world's scenery resolves — the real counts", { skip }, () => {
  const view = viewFromDoc(doc);
  const frame = isoFrame(view, view.maxLevel, F.windows[0].origin.storey_pitch);
  const all = buildPlacements(doc.scenery, { frame, levelAt: view.levelAt });
  const shown = buildPlacements(doc.scenery, {
    frame,
    levelAt: view.levelAt,
    roofed: roofedCells(doc.decks, doc.size.w),
    width: doc.size.w,
  });
  assert.equal(all.length, doc.scenery.length);
  assert.equal(shown.length, all.length, "roofed pieces are flagged, never dropped");
  const indoors = shown.filter((p) => p.roofed);
  assert.ok(indoors.length > 0, "some pieces are indoors");
  // The interiors' furnishing is the thing this flag exists for, and it is a
  // large share of the map — if it ever reads 0 again, every house on the_game
  // is empty in the game while its furniture still blocks the player.
  assert.ok(indoors.length > 50, `${indoors.length} indoor placements`);
  assert.ok(distinctPieces(indoors).length > 10, "and they are many distinct pieces");
  const ids = distinctPieces(shown);
  assert.ok(ids.length * 4 < shown.length, `${ids.length} distinct pieces for ${shown.length} placements`);
  for (const id of ids) assert.ok(existsSync(rel(manifestPath(id))), `${id} exists`);
  // Every placement stands on a real cell, at that cell's own level.
  for (const p of shown) {
    assert.equal(p.level, doc.level[p.cy][p.cx]);
    assert.ok(p.cx >= 0 && p.cx < doc.size.w && p.cy >= 0 && p.cy < doc.size.h);
  }
});

/* -- the index --------------------------------------------------------------- */

test("a window query returns exactly what a full scan returns", { skip }, () => {
  const view = viewFromDoc(doc);
  const frame = isoFrame(view, view.maxLevel, F.windows[0].origin.storey_pitch);
  const ps = buildPlacements(doc.scenery, {
    frame,
    levelAt: view.levelAt,
    roofed: roofedCells(doc.decks, doc.size.w),
    width: doc.size.w,
  });
  const idx = new SceneryIndex(ps, { bucket: 512 });
  const scan = (v: { x: number; y: number; w: number; h: number }, pad: number) =>
    ps.filter(
      (p) =>
        p.ax >= v.x - pad / 2 &&
        p.ax <= v.x + v.w + pad / 2 &&
        p.ay >= v.y &&
        p.ay <= v.y + v.h + pad,
    );
  let touched = 0;
  for (let i = 0; i < 40; i++) {
    const v = { x: 2000 + i * 700, y: 1000 + i * 330, w: 1920, h: 1080 };
    const got = idx.query(v);
    assert.deepEqual(got.map((p) => p.order), scan(v, MAX_ART_PX).map((p) => p.order), `window ${i}`);
    for (let j = 1; j < got.length; j++) assert.ok(got[j].order > got[j - 1].order, "painter order");
    touched += got.length;
  }
  assert.ok(touched > 0, "the sampled windows actually contain scenery");
  // And the index is worth having: no camera window sees anything like all of it.
  const one = idx.query({ x: 8000, y: 4000, w: 1920, h: 1080 });
  assert.ok(one.length < ps.length / 4, `${one.length} of ${ps.length} in one window`);
  assert.ok(idx.occupancy.used > 1);
});

test("the query pad is asymmetric — art rises from its feet, never below them", { skip }, () => {
  const frame = isoFrame({ x0: 0, y0: 0, x1: 64, y1: 64 }, 0, 15);
  const ps = buildPlacements(
    [
      { piece: "a/1", x: 10.5, y: 10.5 },
      { piece: "a/2", x: 20.5, y: 20.5 },
      { piece: "a/3", x: 40.5, y: 40.5 },
    ],
    { frame, levelAt: () => 0 },
  );
  const idx = new SceneryIndex(ps, { bucket: 64, maxArtPx: 200 });
  const p2 = ps[1];
  // Feet 150px BELOW the window: a 200px-tall piece still reaches into it.
  assert.ok(idx.query({ x: p2.ax - 50, y: p2.ay - 150 - 10, w: 100, h: 10 }).some((p) => p.order === p2.order));
  // Feet 10px ABOVE the window: nothing this piece draws can reach down.
  assert.ok(!idx.query({ x: p2.ax - 50, y: p2.ay + 10, w: 100, h: 400 }).some((p) => p.order === p2.order));
  assert.deepEqual(new SceneryIndex([]).query({ x: 0, y: 0, w: 10, h: 10 }), []);
});

/* -- urls, keys and the lazy cache ------------------------------------------- */

test("urls route through staging and the version pin; keys are content", { skip }, () => {
  assert.equal(manifestPath("bushes/bush_001"), "scenery/bushes/bush_001/scenery.json");
  assert.equal(artPath("bushes/bush_001/sprite.webp"), "scenery/bushes/bush_001/sprite.webp");
  assert.equal(artUrl("bushes/bush_001/sprite.webp"), "/assets/scenery/bushes/bush_001/sprite.webp");
  const route = { gameUrl: (u: string) => `https://cdn/x${u}`, withV: (u: string) => `${u}?v=sha` };
  assert.equal(manifestUrl("bushes/bush_001", route), "https://cdn/x/assets/scenery/bushes/bush_001/scenery.json?v=sha");
  // The key carries the CONTENT and nothing else — no cell, no placement index.
  assert.equal(artKey("bushes/bush_001/sprite.webp"), "s3:bushes/bush_001/sprite.webp");
});

test("the load list is per DISTINCT piece, not per placement", { skip }, () => {
  const frame = isoFrame({ x0: 0, y0: 0, x1: 64, y1: 64 }, 0, 15);
  const ps = buildPlacements(
    [
      { piece: "a/1", x: 1.5, y: 1.5 },
      { piece: "a/1", x: 2.5, y: 2.5, hflip: true },
      { piece: "a/2", x: 3.5, y: 3.5 },
    ],
    { frame, levelAt: () => 0 },
  );
  const made: Record<string, SceneryPiece> = {
    "a/1": parsePiece("a/1", {
      sprite: "a/1/sprite.webp",
      states: { NOT_LIT_1: { sprite: "a/1/sprite.webp", animations: { wind: { frame_paths: ["a/1/animations/wind/00.webp"], frame_count: 1 } } } },
    })!,
    "a/2": parsePiece("a/2", { sprite: "a/2/sprite.webp" })!,
  };
  assert.deepEqual(distinctPieces(ps), ["a/1", "a/2"]);
  assert.deepEqual(
    sceneryLoads(ps, (id) => made[id]).map((l) => l.path),
    ["scenery/a/1/sprite.webp", "scenery/a/2/sprite.webp"],
  );
  assert.equal(sceneryLoads(ps, (id) => made[id], { anims: true }).length, 3);
  // A piece whose manifest has not landed contributes nothing and does not throw.
  assert.deepEqual(sceneryLoads(ps, () => undefined), []);
});

test("manifests load once per piece, failures tombstone, warnings fire once", { skip }, async () => {
  const seen: string[] = [];
  const warns: string[] = [];
  const store = new SceneryPieces({
    fetchJson: async (url) => {
      seen.push(url);
      if (url.includes("/dead/")) throw new Error("404");
      return { sprite: "g/p/sprite.webp" };
    },
    warn: (m) => warns.push(m),
  });
  assert.equal(store.get("g/p"), undefined, "synchronous until it lands");
  await Promise.all([store.request("g/p"), store.request("g/p"), store.request("g/p")]);
  assert.equal(seen.length, 1, "three requests, one fetch");
  assert.equal(store.get("g/p")!.sprite, "g/p/sprite.webp");
  await store.ensure(["g/dead", "g/dead", "g/p"]);
  assert.equal(store.get("g/dead"), null, "a tombstone, not a retry");
  await store.request("g/dead");
  assert.equal(seen.filter((u) => u.includes("/dead/")).length, 1);
  assert.deepEqual(store.stats, { requested: 2, loaded: 1, failed: 1 });
  assert.equal(warns.length, 1, "one line for a dead piece, not one per frame");
});

test("a landed manifest fires onLanded once per piece, after the verdict, tombstones included", async () => {
  const verdicts: unknown[] = [];
  const store = new SceneryPieces({
    fetchJson: async (url) => {
      if (url.includes("/dead/")) throw new Error("404");
      return { sprite: "g/p/sprite.webp" };
    },
    warn: () => {},
    // What the scene's rebuild reads must already be there when this fires.
    onLanded: () => verdicts.push([store.get("g/p"), store.get("g/dead")]),
  });
  await Promise.all([store.request("g/p"), store.request("g/p"), store.request("g/p")]);
  assert.equal(verdicts.length, 1, "three requests, one landing");
  assert.equal((verdicts[0] as any)[0].sprite, "g/p/sprite.webp", "the cache holds the manifest before the hook");
  await store.request("g/dead");
  assert.equal(verdicts.length, 2, "a tombstone lands too — a rebuild must stop waiting on it");
  assert.equal((verdicts[1] as any)[1], null, "the tombstone is in the cache before the hook");
  await store.request("g/p");
  await store.request("g/dead");
  await store.ensure(["g/p", "g/dead"]);
  assert.equal(verdicts.length, 2, "a cached verdict never re-fires");
});

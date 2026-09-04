// ============================================================================
// TILES3DRAW — the two pixel operations, the keys, the load list, the ops
// ============================================================================
//
// client/src/tiles3.ts resolves a cell and stops at the edge of pixels: it says
// "compose plate A and plate B through mask frame N" and "this 64x64 art is not
// plate geometry yet". client/src/tiles3draw.ts is the half that has pixels, so
// this is the gate that keeps it honest.
//
// Both operations are PORTS, and a port's failure mode is a picture that looks
// fine and is not the picture. So both are checked byte for byte — as sha256 of
// the raw RGBA — against a fixture generated out of render3.py itself
// (games2/scripts/tiles3draw-fixture.py), plus the seam that render3 does not
// draw and the pattern library says is mandatory. Alongside the rasters the
// gate pins the things a sha cannot explain: that the alpha IS the published
// silhouette, that a seam only ever darkens, that a pure frame carries no seam
// at all, and that the pattern-frame arithmetic survives a non-default row.
//
// The KEYS are gated as hard as the pixels, because the cache law is absolute:
// a key must be a function of the content and of nothing else. Same inputs ->
// one texture; any changed input -> a new key that cannot overwrite the old.
//
// SKIPPED, NOT FAILED, WHEN THE DATA IS ABSENT — the deploy workflow's test job
// sparse-checks-out games2 + characters2 + maps2/worlds + live, so tiles/ and
// maps2/worlds3 are not there. Same guard as tiles3.test.ts and world3.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tiles3, viewFromDoc, hexRGB, TILE, PLATE_H, TOP_Y, DX, DY } from "../../client/src/tiles3";
import {
  patternSheets,
  patternSheetPaths,
  patternSheetLoads,
  composeBoundary,
  conformPlate,
  cropToArt,
  topFaceMask,
  topFaceOnly,
  capWallToSurface,
  liquidDiamond,
  rint,
  artKey,
  assetPath,
  plateKey,
  plateSourceId,
  boundaryKey,
  boundaryKeyFor,
  liquidKey,
  windowArtLoads,
  windowOps,
  cellOps,
  boundaryOp,
  deckOps,
  Tiles3Textures,
  NEAREST,
  WALL_D,
  type Pixels,
  type PatternSheets,
  type CanvasLike,
  type Ctx2DLike,
  type ImageDataLike,
  type TextureManagerLike,
} from "../../client/src/tiles3draw";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const FIXTURE = join(HERE, "fixtures", "tiles3draw-parity.json");
const rel = (p: string) => join(REPO, p);

const NEEDS = [
  "tiles/patterns/index.json",
  "tiles/ground_types.json",
  "tiles/resolve.json",
  "tiles/review/manifest.json",
  "tiles/fades/index.json",
  "live/tuning/base_tile_sets.json",
  "live/tuning/base_tiles.json",
  "live/tuning/tile_walls.json",
  "live/feedback/tiles.json",
  "maps2/worlds3/the_game/world.json",
];
const MISSING = [FIXTURE, ...NEEDS.map(rel)].filter((p) => !existsSync(p));
const skip = !!MISSING.length;
const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));

const F: any = skip ? null : JSON.parse(readFileSync(FIXTURE, "utf8"));

if (skip)
  test(`tiles3draw parity SKIPPED — not in this checkout: ${MISSING.map((m) => m.replace(REPO + "/", "")).join(", ")}`, () => {
    assert.ok(true);
  });

/* -- the world this gate reads --------------------------------------------- */

const px = (path: string): Pixels => {
  const i = imgRGBA(rel(path)) as { width: number; height: number; data: Uint8Array };
  return { w: i.width, h: i.height, data: new Uint8ClampedArray(i.data) };
};
const rasterSha = (p: Pixels): string => createHash("sha256").update(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.length)).digest("hex");
const fileSha = (path: string): string => createHash("sha256").update(readFileSync(rel(path))).digest("hex");

let PAT: any = null;
let SHEETS: PatternSheets = null as unknown as PatternSheets;
let GT: Record<string, any> = {};
if (!skip) {
  PAT = load("tiles/patterns/index.json");
  const p = patternSheetPaths(PAT);
  SHEETS = patternSheets(PAT, px(p.silhouette), px(p.masks), px(p.border));
  GT = load("tiles/ground_types.json").grounds;
}
const wallRGB = (g: string): [number, number, number] => hexRGB(GT[g].palette.wall);

/* -- 0. the library has not moved under the fixture ------------------------- */

test("the pattern sheets are the bytes the fixture was generated from", { skip }, () => {
  for (const [k, v] of Object.entries(F.sheets as Record<string, { path: string; sha: string }>))
    assert.equal(fileSha(v.path), v.sha, `${k} (${v.path}) was republished — regenerate the fixture`);
  assert.equal(SHEETS.fw, F.constants.frame_w);
  assert.equal(SHEETS.fh, F.constants.frame_h);
  assert.equal(SHEETS.cols, F.constants.cols);
  assert.equal(SHEETS.tone, F.constants.tone);
  assert.equal(WALL_D, F.constants.wall_d);
  let opaque = 0;
  for (const v of SHEETS.sil) if (v > 0) opaque++;
  assert.equal(opaque, F.constants.silhouette_opaque);
});

test("the sheets are strictly binary, so no threshold can matter", { skip }, () => {
  const p = patternSheetPaths(PAT);
  for (const path of [p.silhouette, p.masks, p.border]) {
    const im = px(path);
    let partial = 0;
    for (let i = 3; i < im.data.length; i += 4) if (im.data[i] > 0 && im.data[i] < 255) partial++;
    assert.equal(partial, 0, `${path} carries anti-aliased alpha`);
  }
});

/* THE SEAM'S OWN INVARIANTS, restated here because a draw layer that gets them
 * wrong marks the whole world: frames 0 and 15 are PURE (one ground either
 * way) and must carry no seam at all on any of the 18 patterns, or a field
 * reads as a grid; and no seam pixel may fall outside the silhouette, where it
 * would darken nothing and only prove the frame arithmetic is off. */
test("a pure frame carries no seam, and no seam pixel leaves the silhouette", { skip }, () => {
  let inPure = 0;
  let outside = 0;
  let onWall = 0;
  let total = 0;
  for (const pat of PAT.patterns as { row: number }[])
    for (let idx = 0; idx < SHEETS.cols; idx++) {
      const frame = pat.row * SHEETS.cols + idx;
      for (let y = 0; y < SHEETS.fh; y++)
        for (let x = 0; x < SHEETS.fw; x++) {
          if (!SHEETS.borderBit(frame, x, y)) continue;
          total++;
          if (idx === 0 || idx === 15) inPure++;
          if (SHEETS.sil[y * SHEETS.fw + x] === 0) outside++;
          if (SHEETS.libWall[y * SHEETS.fw + x]) onWall++;
        }
    }
  assert.equal(inPure, 0, "a field of one ground would carry marks");
  assert.equal(outside, 0);
  assert.ok(onWall > total * 0.25, `a third of the seam is the vertical edge a cliff shows (${((100 * onWall) / total).toFixed(1)}%)`);
});

/* -- 1. CONFORM: 64x64 art -> 64x46 plate geometry -------------------------- */

test("conformPlate reproduces render3.conformed_plate, byte for byte", { skip }, () => {
  let n = 0;
  for (const c of F.conform as { ground: string; path: string; sha: string; src_sha: string; opaque: number }[]) {
    assert.equal(fileSha(c.path), c.src_sha, `${c.path} was republished — regenerate the fixture`);
    const got = conformPlate(SHEETS, px(c.path), wallRGB(c.ground));
    assert.equal(got.w, SHEETS.fw);
    assert.equal(got.h, SHEETS.fh);
    assert.equal(rasterSha(got), c.sha, `${c.ground} <- ${c.path}`);
    n++;
  }
  assert.ok(n >= 30, `${n} conform cases`);
});

test("a conformed plate IS the silhouette, and its wall IS the palette", { skip }, () => {
  const c = (F.conform as any[])[0];
  const got = conformPlate(SHEETS, px(c.path), wallRGB(c.ground));
  const want = wallRGB(c.ground);
  let opaque = 0;
  let wallWrong = 0;
  let bleed = 0;
  for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++) {
    const a = got.data[i * 4 + 3];
    const sil = SHEETS.sil[i] > 0;
    assert.equal(a > 0, sil, `alpha disagrees with the silhouette at ${i}`);
    if (a > 0) opaque++;
    if (SHEETS.libWall[i] && (got.data[i * 4] !== want[0] || got.data[i * 4 + 1] !== want[1] || got.data[i * 4 + 2] !== want[2])) wallWrong++;
    // rgb under a transparent pixel is zeroed — what the canvas stores anyway
    if (!sil && (got.data[i * 4] || got.data[i * 4 + 1] || got.data[i * 4 + 2])) bleed++;
  }
  assert.equal(opaque, F.constants.silhouette_opaque);
  assert.equal(wallWrong, 0, "the wall is filled from the ground's palette wall colour, every pixel");
  assert.equal(bleed, 0);
});

test("the crop is a fixed window at the art's top row, not the alpha bbox", { skip }, () => {
  // A source whose LAST row is empty must still come out fh tall with its art
  // at row 0 — a bbox crop would give fh-1 and every downstream mask index
  // would be a row off.
  const src: Pixels = { w: TILE, h: TILE, data: new Uint8ClampedArray(TILE * TILE * 4) };
  for (let y = 5; y < 40; y++)
    for (let x = 0; x < TILE; x++) {
      const i = (y * TILE + x) * 4;
      src.data[i] = 9;
      src.data[i + 1] = 9;
      src.data[i + 2] = 9;
      src.data[i + 3] = 255;
    }
  const out = cropToArt(src, TILE, PLATE_H);
  assert.equal(out.h, PLATE_H);
  assert.equal(out.data[3], 255, "the art's first row lands on row 0");
  assert.equal(out.data[(35 * TILE) * 4 + 3], 0, "and rows past the art are transparent");
});

test("topFaceMask is the silhouette's own extrusion, not a rhombus", { skip }, () => {
  // Per column: everything above the last WALL_D rows. On the library's own
  // silhouette that is exactly the published top-face pixel count.
  let top = 0;
  for (const v of SHEETS.libTop) if (v) top++;
  assert.equal(top, PAT.geometry.top_face_px, "the library publishes this number");
  let wall = 0;
  for (const v of SHEETS.libWall) if (v) wall++;
  assert.equal(wall, PAT.geometry.wall_px);
  assert.equal(top + wall, PAT.geometry.opaque_px);
  // and a synthetic column proves the WALL_D arithmetic directly
  const w = 1;
  const h = 40;
  const on = new Set([10, 11, 12, 30, 31]);
  const m = topFaceMask(w, h, (i) => on.has(i));
  for (let y = 0; y < h; y++) assert.equal(!!m[y], on.has(y) && y <= 31 - WALL_D, `row ${y}`);
});

/* -- 2. COMPOSE: the boundary, and the seam that is not optional ------------ */

test("composeBoundary reproduces the reference compose AND the published seam", { skip }, () => {
  let n = 0;
  for (const c of F.boundary as any[]) {
    for (const side of [c.a, c.b]) assert.equal(fileSha(side.path), side.src_sha, `${side.path} was republished`);
    const pa = c.a.kind === "conform" ? conformPlate(SHEETS, px(c.a.path), wallRGB(c.a.ground)) : px(c.a.path);
    const pb = c.b.kind === "conform" ? conformPlate(SHEETS, px(c.b.path), wallRGB(c.b.ground)) : px(c.b.path);
    const seamed = composeBoundary(SHEETS, c.frame, pa, pb);
    assert.equal(rasterSha(seamed), c.sha, `${c.a.ground}/${c.b.ground} ${c.pattern}#${c.index}`);
    // render3's literal two-line rule, for the diff against the still render
    const bare = composeBoundary(SHEETS, c.frame, pa, pb, { seam: false });
    assert.equal(rasterSha(bare), c.sha_noseam, `${c.a.ground}/${c.b.ground} ${c.pattern}#${c.index} unseamed`);
    n++;
  }
  assert.ok(n >= 24, `${n} boundary cases`);
});

test("out.rgb = mask ? B : A, out.alpha = the silhouette — recomputed, not trusted", { skip }, () => {
  // The fixture pins the bytes; this pins the RULE, straight off the plates and
  // the mask, so a fixture regenerated from a drifted spec cannot hide a drifted
  // port.
  const c = (F.boundary as any[]).find((b) => b.a.kind === "clean" && b.b.kind === "clean");
  assert.ok(c, "the fixture carries a clean/clean pair");
  const pa = px(c.a.path);
  const pb = px(c.b.path);
  const got = composeBoundary(SHEETS, c.frame, pa, pb, { seam: false });
  let checked = 0;
  for (let y = 0; y < SHEETS.fh; y++)
    for (let x = 0; x < SHEETS.fw; x++) {
      const i = y * SHEETS.fw + x;
      assert.equal(got.data[i * 4 + 3], SHEETS.sil[i], `alpha at ${x},${y}`);
      if (SHEETS.sil[i] === 0) continue;
      const src = SHEETS.maskBit(c.frame, x, y) ? pb : pa;
      for (let ch = 0; ch < 3; ch++) assert.equal(got.data[i * 4 + ch], src.data[i * 4 + ch], `ch${ch} at ${x},${y}`);
      checked++;
    }
  assert.equal(checked, F.constants.silhouette_opaque);
});

test("the seam only ever darkens, only on border pixels, and only inside the tile", { skip }, () => {
  for (const c of F.boundary as any[]) {
    const pa = c.a.kind === "conform" ? conformPlate(SHEETS, px(c.a.path), wallRGB(c.a.ground)) : px(c.a.path);
    const pb = c.b.kind === "conform" ? conformPlate(SHEETS, px(c.b.path), wallRGB(c.b.ground)) : px(c.b.path);
    const bare = composeBoundary(SHEETS, c.frame, pa, pb, { seam: false });
    const seam = composeBoundary(SHEETS, c.frame, pa, pb);
    let touched = 0;
    for (let y = 0; y < SHEETS.fh; y++)
      for (let x = 0; x < SHEETS.fw; x++) {
        const i = y * SHEETS.fw + x;
        const onSeam = SHEETS.borderBit(c.frame, x, y) && SHEETS.sil[i] > 0;
        let moved = false;
        for (let ch = 0; ch < 3; ch++) {
          const a = bare.data[i * 4 + ch];
          const b = seam.data[i * 4 + ch];
          assert.ok(b <= a, `the seam lightened ch${ch} at ${x},${y}`);
          if (b !== a) moved = true;
        }
        assert.ok(!moved || onSeam, `a non-border pixel moved at ${x},${y}`);
        if (onSeam) touched++;
      }
    assert.equal(touched, c.seam_px, `${c.pattern}#${c.index}`);
    // index 15 is pure side_b: no seam, and the composition IS plate B
    if (c.index === 15) assert.equal(c.seam_px, 0);
  }
});

test("the seam rounds HALF TO EVEN — np.rint, not Math.round", { skip }, () => {
  // HALF TO EVEN both ways: .5 goes DOWN from an odd floor and UP from an even
  // one. Nothing else about the seam is arithmetic, so this is the whole rule.
  assert.equal(rint(20.5), 20);
  assert.equal(rint(21.5), 22);
  assert.equal(rint(20.4), 20);
  assert.equal(rint(20.6), 21);
  // AND IT MATTERS AT THIS TONE. Sweeping every channel value, exactly three —
  // 25, 125, 225 — land on a representable .5 whose floor is even, where rint
  // rounds down and Math.round rounds up. (Not five: 75 * 0.82 is
  // 61.4999999999999929 in a double, and 175 * 0.82 = 143.5 has an ODD floor,
  // so both roundings already agree there. The wiki's compose gate hunts a
  // plate carrying one of the three for the same reason.)
  const tone = SHEETS.tone;
  const differ: number[] = [];
  for (let v = 0; v < 256; v++) if (rint(v * tone) !== Math.round(v * tone)) differ.push(v);
  assert.deepEqual(differ, [25, 125, 225]);
});

test("composition refuses art that is not plate geometry", { skip }, () => {
  // A raw 64x64 review tile substituted for a plate puts 928 of 2012 px in the
  // wrong alpha, silently. It must throw, not compose.
  const c = (F.boundary as any[])[0];
  const raw: Pixels = { w: TILE, h: TILE, data: new Uint8ClampedArray(TILE * TILE * 4) };
  assert.throws(() => composeBoundary(SHEETS, c.frame, raw, px(c.b.kind === "clean" ? c.b.path : c.a.path)), /plate geometry/);
});

/* NEAREST IS 1, NOT 0. Phaser's FilterMode is { LINEAR: 0, NEAREST: 1 }, so the
 * plausible constant is the one that sets the exact filter this repo has twice
 * paid for. Read out of Phaser's own source, because a hardcoded number in a
 * module that must not import Phaser is otherwise unverifiable. */
const PHASER_CONST = join(REPO, "games2", "node_modules", "phaser", "src", "textures", "const.js");
test("NEAREST is Phaser's own value, read from Phaser", { skip: !existsSync(PHASER_CONST) }, () => {
  const src = readFileSync(PHASER_CONST, "utf8");
  const m = /NEAREST:\s*(\d+)/.exec(src);
  assert.ok(m, "phaser/src/textures/const.js still declares FilterMode.NEAREST");
  assert.equal(NEAREST, Number(m![1]));
  assert.notEqual(NEAREST, Number(/LINEAR:\s*(\d+)/.exec(src)![1]));
});

/* -- 3. KEYS: the cache law ------------------------------------------------- */

const PA = { kind: "plate", path: "tiles/plates/grass/1a2b3c4d.webp", member: "m", stale: false, w: TILE, h: PLATE_H } as const;
const PB = { kind: "clean", path: "tiles/plates/snow/clean.webp", member: null, stale: false, w: TILE, h: PLATE_H } as const;
const PC = { kind: "conform", path: "tiles/tops/grass/x.webp", member: "m", stale: false, w: TILE, h: PLATE_H } as const;

test("a key is a function of the content and of nothing else", () => {
  // Same inputs -> one key. Nothing here mentions a cell coordinate.
  assert.equal(boundaryKey(145, plateSourceId(PA, "grass"), plateSourceId(PB, "snow")), boundaryKey(145, plateSourceId(PA, "grass"), plateSourceId(PB, "snow")));
  const base = boundaryKey(145, "p:a", "p:b");
  // Every input that changes the pixels mints a NEW key.
  assert.notEqual(base, boundaryKey(146, "p:a", "p:b"), "the mask frame");
  assert.notEqual(base, boundaryKey(145, "p:a2", "p:b"), "plate A");
  assert.notEqual(base, boundaryKey(145, "p:a", "p:b2"), "plate B");
  assert.notEqual(base, boundaryKey(145, "p:b", "p:a"), "the SIDES, which are ordered by the library, not sorted here");
  assert.notEqual(base, boundaryKey(145, "p:a", "p:b", false), "the seam pass");
  // A conformed plate's ground is content: it supplies the wall colour.
  assert.notEqual(plateSourceId(PC, "grass"), plateSourceId(PC, "snow"));
  assert.notEqual(plateKey(PC, "grass"), plateKey(PC, "snow"));
  // A published plate's ground is NOT content — the file is already the pixels.
  assert.equal(plateKey(PA, "grass"), plateKey(PA, "snow"));
  assert.equal(plateKey(PA, "grass"), artKey(PA.path));
  // Painted diamonds are keyed by the colour that is their whole content.
  assert.equal(liquidKey([1, 2, 3]), liquidKey([1, 2, 3]));
  assert.notEqual(liquidKey([1, 2, 3]), liquidKey([1, 2, 4]));
  // and no key is a mutable name: each carries its inputs verbatim
  assert.match(base, /^t3x:145\|p:a\|p:b$/);
  assert.match(plateKey(PC, "grass"), /^t3c:grass\|tiles\/tops\/grass\/x\.webp$/);
});

test("the art key namespace is the renderer's existing one", () => {
  // client/src/maps.ts pathTileKey — the world@1/world@2 draw sites resolve a
  // texture by path through this exact prefix, so tiles3 art needs no branch.
  const maps = readFileSync(join(REPO, "games2", "client", "src", "maps.ts"), "utf8");
  const m = /export function pathTileKey\(path: string\): string \{\s*return "([^"]+)" \+ path;/.exec(maps);
  assert.ok(m, "maps.ts still defines pathTileKey as a prefix + path");
  assert.equal(artKey("x/y.webp"), m![1] + "x/y.webp");
  const am = /export function assetUrl\(path: string\): string \{\s*return "([^"]+)" \+/.exec(maps);
  assert.ok(am, "maps.ts still defines assetUrl");
  assert.equal(assetPath("x/y.webp"), am![1] + "x/y.webp");
});

/* -- 4. the load list ------------------------------------------------------- */

test("the load list routes every URL through staging and the version pin", () => {
  const win: any = {
    frame: {},
    regions: {},
    cells: [
      { art: { kind: "plate", path: "tiles/plates/g/a.webp", w: 64, h: 46 } },
      { art: { kind: "conform", path: "tiles/tops/g/b.webp", w: 64, h: 46 } },
      { art: { kind: "liquid", topRGB: [1, 2, 3], w: 64, h: 64 } },
      { art: { kind: "plate", path: "tiles/plates/g/a.webp", w: 64, h: 46 } }, // dup
      { wall: { stack: [{ tile: { path: "tiles/review/x.webp", w: 64, h: 64 } }] } },
    ],
    boundaries: [{ plateA: { kind: "clean", path: "tiles/plates/g/clean.webp" }, plateB: { kind: "conform", path: "tiles/tops/g/b.webp" } }],
    decks: [{ stack: [{ tile: { path: "tiles/review/d.webp", w: 64, h: 64 } }] }],
  };
  const loads = windowArtLoads(win, { gameUrl: (u) => (u.startsWith("/assets/") ? "https://cdn/" + u.slice(8) : u), withV: (u) => u + "?v=abc" });
  const paths = loads.map((l) => l.path).sort();
  assert.deepEqual(paths, ["tiles/plates/g/a.webp", "tiles/plates/g/clean.webp", "tiles/review/d.webp", "tiles/review/x.webp", "tiles/tops/g/b.webp"]);
  assert.equal(loads.length, new Set(paths).size, "deduplicated: one load per file");
  for (const l of loads) {
    assert.equal(l.key, artKey(l.path));
    assert.equal(l.url, `https://cdn/${l.path}?v=abc`);
  }
  // no route -> the plain image path, which is what a normal player gets
  assert.equal(windowArtLoads(win)[0].url, "/assets/tiles/plates/g/a.webp");
  // the SOURCE of a conform is in the list: the conformed raster is derived
  // from it at build time, so the file itself must be resident
  assert.ok(paths.includes("tiles/tops/g/b.webp"));
});

test("the pattern sheets come from the index, not from a spelled-out path", { skip }, () => {
  const loads = patternSheetLoads(PAT);
  assert.equal(loads.length, 3);
  assert.deepEqual(
    loads.map((l) => l.path).sort(),
    [PAT.silhouette.file, PAT.masks.file, PAT.border.file].sort(),
  );
  for (const l of loads) assert.equal(l.key, artKey(l.path));
});

/* -- 5. draw ops ------------------------------------------------------------ */

test("a cell's ops carry the resolver's own geometry", () => {
  const field: any = { kind: "field", ground: "grass", sx: 100, sy: 50, pasteY: 50, art: { kind: "plate", path: "p.webp", w: 64, h: 46 } };
  assert.deepEqual(cellOps(field), [{ key: artKey("p.webp"), x: 100, y: 50, sx: 0, sy: 0, sw: 64, sh: 46, role: "surface" }]);
  // a fade is cropped to the top diamond: the op carries the crop, not a guess
  const fade: any = { kind: "field", ground: "grass", sx: 0, sy: 0, pasteY: -TOP_Y, art: { kind: "fade", path: "f.webp", w: TILE, h: TOP_Y + 2 * DY + 2 } };
  assert.equal(cellOps(fade)[0].sh, TOP_Y + 2 * DY + 2);
  // a liquid paints; it never loads
  const liq: any = { kind: "field", ground: "water", sx: 7, sy: 8, pasteY: -2, art: { kind: "liquid", topRGB: [1, 2, 3], w: 64, h: 64 } };
  assert.equal(cellOps(liq)[0].key, liquidKey([1, 2, 3]));
  // a wall is its stack, lowest storey first, at the stack's own y
  const wall: any = { kind: "wall", ground: "grey_stone", sx: 5, sy: 9, wall: { stack: [{ storey: 0, tile: { path: "a.webp", w: 64, h: 64 }, y: 30 }, { storey: 1, tile: { path: "b.webp", w: 64, h: 64 }, y: 15 }] } };
  assert.deepEqual(
    cellOps(wall).map((o) => [o.key, o.x, o.y, o.role]),
    [[artKey("a.webp"), 5, 30, "wall"], [artKey("b.webp"), 5, 15, "wall"]],
  );
  const deck: any = { sx: 4, stack: [{ tile: { path: "c.webp", w: 64, h: 64 }, y: 11 }] };
  assert.deepEqual(deckOps(deck).map((o) => [o.key, o.x, o.y, o.role]), [[artKey("c.webp"), 4, 11, "deck"]]);
});

test("a boundary with no published pattern draws nothing, never a hole", () => {
  const b: any = { maskFrame: null, plateA: { kind: "clean", path: "a" }, plateB: { kind: "clean", path: "b" }, a: "g", b: "s", sx: 0, sy: 0, w: 64, h: 46 };
  assert.equal(boundaryKeyFor(b), null);
  assert.equal(boundaryOp(b), null);
});

/* -- 6. the factory: build once, NEAREST always, eviction is safe ----------- */

/** A canvas that is only arrays — enough of the shape for the factory, and
 *  enough to read back what it registered. */
function fakeCanvas(w: number, h: number): CanvasLike & { pix: Uint8ClampedArray } {
  const pix = new Uint8ClampedArray(Math.max(1, w * h * 4));
  const ctx: Ctx2DLike = {
    createImageData: (cw, ch) => ({ width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }),
    putImageData: (d: ImageDataLike) => pix.set(d.data),
    getImageData: (_x, _y, gw, gh) => ({ width: gw, height: gh, data: pix }),
    drawImage: () => {
      throw new Error("the fake never needs a blit: every source is already a canvas");
    },
  };
  const cv = { width: w, height: h, getContext: () => ctx, pix };
  return cv;
}

function fakeTextures() {
  const t = new Map<string, { getSourceImage(): unknown }>();
  const filters: string[] = [];
  const removed: string[] = [];
  const man: TextureManagerLike = {
    exists: (k) => t.has(k),
    get: (k) => t.get(k),
    addCanvas: (k, source) => {
      t.set(k, { getSourceImage: () => source });
      return { setFilter: (m: number) => filters.push(`${k}:${m}`) };
    },
    remove: (k) => {
      t.delete(k);
      removed.push(k);
    },
  };
  const put = (key: string, p: Pixels) => {
    const cv = fakeCanvas(p.w, p.h);
    cv.pix.set(p.data);
    t.set(key, { getSourceImage: () => cv });
  };
  return { man, t, filters, removed, put };
}

test("the factory builds a composition once and NEAREST-filters every canvas", { skip }, () => {
  const c = (F.boundary as any[]).find((b) => b.a.kind === "clean" && b.b.kind === "conform");
  assert.ok(c);
  const fx = fakeTextures();
  fx.put(artKey(c.a.path), px(c.a.path));
  fx.put(artKey(c.b.path), px(c.b.path));
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  const b: any = { maskFrame: c.frame, a: c.a.ground, b: c.b.ground, plateA: c.a, plateB: c.b };
  const k1 = T.boundary(b);
  const k2 = T.boundary({ ...b });
  assert.equal(k1, k2);
  assert.equal(T.stats.built, 1, "one raster for two identical requests");
  assert.equal(T.stats.reused, 1);
  assert.deepEqual(fx.filters, [`${k1}:${NEAREST}`], "addCanvas does NOT inherit pixelArt; LINEAR smears at fractional zoom");
  // and what it registered IS the composition
  const src = fx.man.get(k1 as string)!.getSourceImage() as { pix: Uint8ClampedArray };
  // ...through the SAME pipeline platePixels uses (each side capped), and a
  // level-0 boundary keeps its wall band, exactly like render3's
  // composed_boundary, whose alpha is the full silhouette.
  const pa = capWallToSurface(SHEETS, px(c.a.path));
  const pb = capWallToSurface(SHEETS, conformPlate(SHEETS, px(c.b.path), wallRGB(c.b.ground)));
  assert.equal(
    createHash("sha256").update(Buffer.from(src.pix.buffer, 0, src.pix.length)).digest("hex"),
    rasterSha(capWallToSurface(SHEETS, composeBoundary(SHEETS, c.frame, pa, pb))),
  );
});

/* THE BEACH ZIGZAG, BOTH HALVES (maintainer 2026-09-03 and 2026-09-04).
 *
 * A composed boundary is drawn INSTEAD of the cell's plate, never over it:
 *     if (bop && cell.kind === "field") <transition tile>  else  <plate>
 * so its FOOTPRINT must equal the plate's or the difference is painted by
 * nothing. render3's composed_boundary sets `out[..., 3] = _silhouette()` —
 * the full 2012 texels — which is what makes drawing it instead of the plate
 * lawful there.
 *
 * Masking it to the 924-texel top face (2026-09-03) removed a real defect: a
 * boundary then carried the palette WALL colour, 800 of 1088 texels exactly
 * (171,146,116) on a light_beach<->grass composition, and at the time
 * boundaries were a separate pass drawn after every cell, so nothing covered
 * it. But it left 1088 texels painted by NOTHING. The maintainer's magenta
 * ground clear proved it: 396 bare pixels, 195 runs of exactly 2 screen px —
 * one texel at zoom 2 — on diamond-edge slopes. "As if the transition tiles
 * doesn't have a wall. Ofc they must have a wall."
 *
 * Both are held here at once, which is the only stable resting point: the band
 * EXISTS (footprint parity with render3, so no hole) and carries NONE of either
 * ground's palette wall colour (capped to the surface, so no dark course even
 * if a texel peeks). A raised boundary stays top-face-only — there the cap's
 * own x-over-y art is the wall — and since that is a different picture, the two
 * must not share a texture key. */
test("a level-0 boundary covers the plate silhouette, with no palette wall in it", { skip }, () => {
  let silN = 0;
  for (const v of SHEETS.sil) if (v > 0) silN++;
  let checked = 0;
  for (const c of (F.boundary as any[]).slice(0, 12)) {
    const pa = c.a.kind === "conform" ? conformPlate(SHEETS, px(c.a.path), wallRGB(c.a.ground)) : px(c.a.path);
    const pb = c.b.kind === "conform" ? conformPlate(SHEETS, px(c.b.path), wallRGB(c.b.ground)) : px(c.b.path);
    const raw = composeBoundary(SHEETS, c.frame, pa, pb);
    /* THROUGH THE REAL FACTORY — this gate is about the WIRING. `topOnly` was
     * once a DEAD FLAG here (the resolver set it and `boundary()` never read
     * it), so recomputing the mask in the test would pass against the very bug
     * it is meant to catch. */
    const fx = fakeTextures();
    fx.put(artKey(c.a.path), px(c.a.path));
    fx.put(artKey(c.b.path), px(c.b.path));
    const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
    const base: any = { maskFrame: c.frame, a: c.a.ground, b: c.b.ground, plateA: c.a, plateB: c.b };
    const key = T.boundary(base);
    assert.ok(key, `${c.a.ground}/${c.b.ground} composed nothing`);
    const reg = fx.man.get(key as string)!.getSourceImage() as { pix: Uint8ClampedArray };
    const out: Pixels = { w: SHEETS.fw, h: SHEETS.fh, data: reg.pix };

    const walls = [wallRGB(c.a.ground), wallRGB(c.b.ground)];
    let rawWall = 0;
    let outWall = 0;
    let top = 0;
    let paletteWall = 0;
    for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++) {
      if (SHEETS.libTop[i]) {
        // the blend itself survives byte for byte
        for (let ch = 0; ch < 4; ch++) assert.equal(out.data[i * 4 + ch], raw.data[i * 4 + ch], `${c.a.ground}/${c.b.ground} top px ${i}`);
        if (out.data[i * 4 + 3] > 0) top++;
        continue;
      }
      if (raw.data[i * 4 + 3] > 0) rawWall++;
      if (out.data[i * 4 + 3] > 0) {
        outWall++;
        for (const w of walls) if (out.data[i * 4] === w[0] && out.data[i * 4 + 1] === w[1] && out.data[i * 4 + 2] === w[2]) paletteWall++;
      }
    }
    // NON-VACUOUS: the raw composition really does carry a full wall band.
    assert.ok(rawWall > 1000, `${c.a.ground}/${c.b.ground} raw wall band is only ${rawWall} texels — fixture drifted`);
    assert.equal(top, 924, `${c.a.ground}/${c.b.ground} keeps its whole top face`);
    assert.equal(top + outWall, silN, `${c.a.ground}/${c.b.ground} covers ${top + outWall} of the plate's ${silN} texels — the rest is painted by NOTHING`);
    assert.equal(paletteWall, 0, `${c.a.ground}/${c.b.ground} band carries ${paletteWall} palette-wall texels — that is the dark course`);

    // ...and a RAISED one is still top-face-only, under its own key
    const rk = T.boundary({ ...base, topOnly: true });
    assert.ok(rk && rk !== key, "a raised boundary is a different picture and must not share a key");
    const rreg = fx.man.get(rk as string)!.getSourceImage() as { pix: Uint8ClampedArray };
    let rOpaque = 0;
    for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++) if (rreg.pix[i * 4 + 3] > 0) rOpaque++;
    assert.equal(rOpaque, 924, "a raised boundary stays top-face-only — the cap's own art is the wall");
    checked++;
  }
  assert.ok(checked >= 8, `${checked} boundary cases`);
});



test("a missing source degrades to no boundary, never to a wrong one", { skip }, () => {
  const c = (F.boundary as any[])[0];
  const fx = fakeTextures();
  fx.put(artKey(c.a.path), px(c.a.path)); // side B never loaded
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  assert.equal(T.boundary({ maskFrame: c.frame, a: c.a.ground, b: c.b.ground, plateA: c.a, plateB: c.b } as any), null);
  assert.equal(T.stats.built, 0);
  assert.equal(T.stats.missing, 1);
});

test("eviction is safe because a rebuilt key is byte-identical", { skip }, () => {
  const cases = (F.boundary as any[]).slice(0, 4);
  const fx = fakeTextures();
  for (const c of cases) {
    fx.put(artKey(c.a.path), px(c.a.path));
    fx.put(artKey(c.b.path), px(c.b.path));
  }
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas, limit: 2 });
  const keys = cases.map((c) => T.boundary({ maskFrame: c.frame, a: c.a.ground, b: c.b.ground, plateA: c.a, plateB: c.b } as any));
  assert.equal(new Set(keys).size, keys.length, "four distinct compositions");
  assert.ok(T.stats.evicted >= 2, `the LRU dropped ${T.stats.evicted}`);
  assert.equal(T.stats.live, 2);
  const first = cases[0];
  const before = fx.man.get(keys[0] as string);
  assert.equal(before, undefined, "the oldest was actually removed");
  const again = T.boundary({ maskFrame: first.frame, a: first.a.ground, b: first.b.ground, plateA: first.a, plateB: first.b } as any);
  assert.equal(again, keys[0], "the same content mints the same key, never a new one");
  const src = fx.man.get(again as string)!.getSourceImage() as { pix: Uint8ClampedArray };
  /* Still anchored to the fixture, through the same tail the factory applies: a
   * level-0 boundary keeps the full silhouette (render3's composed_boundary
   * sets alpha to _silhouette(), and the tile is drawn INSTEAD of the plate, so
   * a smaller footprint is a hole), with each side capped first exactly as
   * platePixels caps it. fixture sha -> raw compose -> capped is one chain, so
   * a drifted port still fails the parity gate above and eviction safety is
   * what THIS gate measures. */
  const pa = first.a.kind === "conform" ? conformPlate(SHEETS, px(first.a.path), wallRGB(first.a.ground)) : px(first.a.path);
  const pb = first.b.kind === "conform" ? conformPlate(SHEETS, px(first.b.path), wallRGB(first.b.ground)) : px(first.b.path);
  const raw = composeBoundary(SHEETS, first.frame, pa, pb);
  assert.equal(rasterSha(raw), first.sha, "the fixture still pins the raw composition");
  assert.equal(
    createHash("sha256").update(Buffer.from(src.pix.buffer, 0, src.pix.length)).digest("hex"),
    rasterSha(capWallToSurface(SHEETS, composeBoundary(SHEETS, first.frame, capWallToSurface(SHEETS, pa), capWallToSurface(SHEETS, pb)))),
  );
});

test("a conformed plate is built once per ground, and a liquid once per colour", { skip }, () => {
  const c = (F.conform as any[])[0];
  const fx = fakeTextures();
  fx.put(artKey(c.path), px(c.path));
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  const art: any = { kind: "conform", path: c.path, w: TILE, h: PLATE_H };
  const k1 = T.plate(art, c.ground);
  const k2 = T.plate(art, c.ground);
  assert.equal(k1, k2);
  assert.equal(T.stats.built, 1);
  const other = Object.keys(GT).find((g) => g !== c.ground && GT[g]?.palette?.wall)!;
  assert.notEqual(T.plate(art, other), k1, "the wall colour is content");
  assert.equal(T.stats.built, 2);
  /* A PUBLISHED PLATE IS CAPPED: its wall band is repainted in its own surface
   * colour, so it is a raster under `t3s:`. The raw file keeps `artKey` — that
   * is what a raised cell's WALL STACK draws — and if the raster cannot be
   * built the factory FALLS BACK to it, so this can never drop an op (which is
   * what put tile-sized black holes on the map in cc2b41c975). */
  const pk = T.plate({ kind: "plate", path: c.path, w: TILE, h: PLATE_H } as any, c.ground);
  assert.equal(pk, `t3s:${artKey(c.path)}`);
  assert.notEqual(pk, artKey(c.path));
  assert.equal(T.stats.built, 3);
  // the fallback: an unloaded source yields the raw key, never null-and-dropped
  const T2 = new Tiles3Textures({ textures: fakeTextures().man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  assert.equal(T2.plate({ kind: "plate", path: "nope.webp", w: TILE, h: PLATE_H } as any, c.ground), null);
  const l1 = T.liquid([10, 20, 30]);
  T.liquid([10, 20, 30]);
  assert.equal(T.stats.built, 4);
  const src = fx.man.get(l1)!.getSourceImage() as { pix: Uint8ClampedArray };
  assert.equal(createHash("sha256").update(Buffer.from(src.pix.buffer, 0, src.pix.length)).digest("hex"), rasterSha(liquidDiamond([10, 20, 30], SHEETS)));
});

test("every op the factory hands back is drawable; the rest are dropped", { skip }, () => {
  const c = (F.conform as any[])[0];
  const fx = fakeTextures();
  fx.put(artKey(c.path), px(c.path));
  fx.put("t2:loaded.webp", { w: 1, h: 1, data: new Uint8ClampedArray(4) });
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  // a conform surface is materialised, and the op comes back pointing at it
  const cell: any = { kind: "field", ground: c.ground, sx: 3, sy: 4, pasteY: 4, art: { kind: "conform", path: c.path, w: TILE, h: PLATE_H } };
  const ops = T.opsForCell(cell);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].key, plateKey(cell.art, c.ground));
  assert.ok(fx.man.exists(ops[0].key));
  assert.equal(ops[0].x, 3);
  // a liquid paints itself
  assert.equal(T.opsForCell({ kind: "field", ground: "water", sx: 0, sy: 0, pasteY: 0, art: { kind: "liquid", topRGB: [4, 5, 6], w: TILE, h: TILE } } as any)[0].key, liquidKey([4, 5, 6]));
  // a wall stack keeps the courses that loaded and DROPS the ones that did not
  const wall: any = { kind: "wall", ground: "grey_stone", sx: 0, sy: 0, wall: { stack: [{ storey: 0, tile: { path: "loaded.webp", w: TILE, h: TILE }, y: 1 }, { storey: 1, tile: { path: "never.webp", w: TILE, h: TILE }, y: 2 }] } };
  assert.deepEqual(T.opsForCell(wall).map((o) => o.key), ["t2:loaded.webp"]);
  assert.deepEqual(T.opsForDeck({ sx: 0, stack: [{ tile: { path: "never.webp", w: TILE, h: TILE }, y: 0 }] } as any), []);
  // and a boundary whose plates never loaded draws nothing
  const b = (F.boundary as any[])[0];
  assert.equal(T.opsForBoundary({ maskFrame: b.frame, a: b.a.ground, b: b.b.ground, plateA: b.a, plateB: b.b, sx: 0, sy: 0, w: TILE, h: PLATE_H } as any), null);
});

/* -- 6b. a level-0 published plate NEVER draws its own wall band ------------ */

/** THE LAND ZIGZAG (2026-09-04). `opsForCell`'s last branch drew `op.key` — the
 *  raw file — for any field art that was not conform, not topOnly and not a
 *  liquid ground. That is exactly a level-0 published or clean plate, so
 *  `capWallToSurface` never ran on the cells it was written for and every one
 *  of them painted its ~25%-darker wall course. The cell in front covers almost
 *  all of it; what showed was a broken one-texel run along the diamond edges —
 *  633 texels of exactly (171,146,116) measured off the maintainer's screenshot
 *  at 442.2,382.2, in 116 chevrons.
 *
 *  Two things are asserted, because either alone can pass while the bug is
 *  live: the op must point at the CAPPED raster, and that raster must carry
 *  none of the ground's palette wall colour. The raw file carries 1088. */
test("a level-0 clean plate draws the capped raster, never its wall band", { skip }, () => {
  const path = "tiles/plates/light_beach/clean.webp";
  const raw = px(path);
  assert.equal(raw.h, PLATE_H, "the fixture assumes plate geometry");
  const fx = fakeTextures();
  fx.put(artKey(path), raw);
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  const art: any = { kind: "clean", path, w: TILE, h: PLATE_H };
  const cell: any = { kind: "field", ground: "light_beach", sx: 0, sy: 0, pasteY: 0, art };
  const ops = T.opsForCell(cell);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].key, `t3s:${artKey(path)}`, "a level-0 plate must go through plate(), not draw the raw file");

  const [wr, wg, wb] = wallRGB("light_beach");
  const count = (p: Pixels): number => {
    let n = 0;
    for (let i = 0; i < p.w * p.h; i++)
      if (p.data[i * 4 + 3] > 0 && p.data[i * 4] === wr && p.data[i * 4 + 1] === wg && p.data[i * 4 + 2] === wb) n++;
    return n;
  };
  assert.ok(count(raw) > 500, `the raw file should carry the wall band (got ${count(raw)}) or this gate proves nothing`);
  const drawn = (fx.t.get(ops[0].key) as any).getSourceImage() as { pix: Uint8ClampedArray };
  assert.equal(count({ w: TILE, h: PLATE_H, data: drawn.pix }), 0, "the drawn raster still carries light_beach's palette wall colour");

  // a WALL cell keeps the raw path — a wall course must draw its own art
  fx.put("t2:course.webp", { w: 1, h: 1, data: new Uint8ClampedArray(4) });
  const wall: any = { kind: "wall", ground: "grey_stone", sx: 0, sy: 0, wall: { stack: [{ storey: 0, tile: { path: "course.webp", w: TILE, h: TILE }, y: 0 }] } };
  assert.deepEqual(T.opsForCell(wall).map((o) => o.key), ["t2:course.webp"]);
});

/* -- 6c. a transition tile covers what the plate it replaces covered -------- */

/** THE HOLE (2026-09-04). The ground loop takes ONE of the two, never both:
 *      if (bop && cell.kind === "field") <transition tile>  else  <cell plate>
 *  so a boundary masked to its top face paints 924 texels where the plate it
 *  stands in for paints 2012, and those 1088 are painted by nothing. The
 *  maintainer's magenta-ground-clear screenshot showed it directly: 396 bare
 *  pixels, 195 runs of exactly 2 screen px — one texel at zoom 2 — on
 *  diamond-edge slopes. His read: "as if the transition tiles doesn't have a
 *  wall. Ofc they must have a wall."
 *
 *  A RAISED boundary is still masked (the cap's own art is the wall), so the
 *  two are different pictures and the KEY must separate them — otherwise one
 *  name serves two rasters, which is the cache failure this repo forbids. */
test("a level-0 transition tile covers the full plate silhouette", { skip }, () => {
  const c = (F.boundary as any[]).find((b) => b.a.kind === "clean" && b.b.kind === "clean") ?? (F.boundary as any[])[0];
  assert.ok(c);
  const fx = fakeTextures();
  fx.put(artKey(c.a.path), px(c.a.path));
  fx.put(artKey(c.b.path), px(c.b.path));
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  const base: any = { maskFrame: c.frame, a: c.a.ground, b: c.b.ground, plateA: c.a, plateB: c.b };

  let silN = 0;
  for (const v of SHEETS.sil) if (v > 0) silN++;
  let topN = 0;
  for (const v of SHEETS.libTop) if (v > 0) topN++;
  assert.ok(silN > topN, "the fixture assumes a wall band exists");

  const opaque = (key: string): number => {
    const img = (fx.t.get(key) as any).getSourceImage() as { pix: Uint8ClampedArray };
    let n = 0;
    for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++) if (img.pix[i * 4 + 3] > 0) n++;
    return n;
  };
  const flat = T.boundary(base);
  assert.ok(flat);
  assert.equal(opaque(flat), silN, "a level-0 transition tile must cover the same texels as the plate it replaces");

  const raised = T.boundary({ ...base, topOnly: true });
  assert.ok(raised);
  assert.equal(opaque(raised), topN, "a raised transition tile stays top-face-only — the cap's own art is the wall");

  assert.notEqual(flat, raised, "two different pictures must never share one texture key");
});

/* -- 7. the real world: how many compositions the_game actually asks for ---- */

test("the_game's boundaries share compositions — the ratio, measured", { skip }, () => {
  const groundTypes = load("tiles/ground_types.json").grounds;
  const t = new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes,
    patterns: PAT,
    review: load("tiles/review/manifest.json"),
    feedback: load("live/feedback/tiles.json").entries,
    wallOverrides: load("live/tuning/tile_walls.json").overrides,
    basePromotions: load("live/tuning/base_tiles.json").overrides,
    fades: load("tiles/fades/index.json"),
    slopes: load("tiles/slopes/index.json"),
    topWallOverrides: load("live/tuning/top_walls.json").overrides,
    topOverrides: load("live/tuning/tile_tops.json").overrides,
    // MEASURED elsewhere (tiles3.test.ts); the pitch only moves paste y, and
    // nothing this gate asserts depends on it.
    storeyPitch: 15,
    warn: () => {},
  });
  const doc = load("maps2/worlds3/the_game/world.json");
  /* A STREAMING WINDOW, which is what decides the live cache — not the world.
   * CENTRED ON THE TOWN, not on the map centre: since the boundary moved onto
   * the cell itself, no quad touching a liquid composes at all (a coast is a
   * hard edge), and the middle of a 196,368-cell ocean now holds 72. The four
   * grounds that actually meet are here. */
  const win = t.resolveWindow(viewFromDoc(doc, { x0: 368, y0: 328, x1: 432, y1: 392 }));
  const keys = win.boundaries.map((b) => boundaryKeyFor(b)).filter((k): k is string => !!k);
  const distinct = new Set(keys);
  assert.ok(win.boundaries.length > 100, `${win.boundaries.length} boundaries in a 64x64-cell window`);
  assert.ok(distinct.size < win.boundaries.length, `${win.boundaries.length} boundaries share ${distinct.size} compositions`);
  /* WHAT A WINDOW COSTS THE LIVE CACHE, and it grew on purpose (2026-09-04).
   * Three changes each added compositions where the game used to draw a hard
   * edge: the coast composes (the liquid veto is gone), a cross-level quad
   * composes with every corner voting its own ground, and light_soil left
   * MADE_GROUND. Measured on real border quads, the transition rate went from
   * 84.0% at level 0 / 45.6% raised to 100% at every elevation — which is the
   * maintainer's "FIX SO THE TRANSITION WORK ON HIGH GROUND", and the cache
   * bill for it is this number.
   *
   * 1,100 at 64x64 is ~13 MB of canvas against the 25 MB ceiling the unbounded
   * cache was sized for (Tiles3TexturesOpts.limit is 0, deliberately — see
   * WorldScene). If this gate trips again, the question is whether the cache
   * should stay unbounded, not whether to raise the number again. */
  assert.ok(distinct.size < 1100, `a 64x64-cell window holds ${distinct.size} compositions`);
  // every op the window emits resolves to a key, and every art key it names is
  // in the load list — no draw can reference something nothing fetches
  const loads = new Set(windowArtLoads(win).map((l) => l.key));
  for (const op of windowOps(win))
    if (op.key.startsWith("t2:")) assert.ok(loads.has(op.key), `${op.key} is drawn but never loaded`);
  console.log(`      the_game 64x64 window: ${win.boundaries.length} boundaries, ${distinct.size} distinct compositions (${(win.boundaries.length / distinct.size).toFixed(2)}x reuse)`);
});

/* -- the water keeps its wall band off ------------------------------------- */

// THE SEA'S DARK LATTICE (maintainer 2026-08-29: "The water has visible edges
// that is not visible in the wiki... a dark blue tile line close to the
// beach"). render3 draws a liquid as top_face_only(surface()); the client set
// `topOnly` on the art and no draw path ever read it, so every water cell
// painted its WALL BAND too. On the_game's water plates that band is 1088 px
// against a 924 px top face, and darker (76,138,152) than the water above it
// (126,183,199) — tiled, a dark lattice over the sea; at the shore, a hard line
// with no cell in front to cover it.

const WATER_PLATES = [
  "tiles/plates/water/aa3287b9.webp",
  "tiles/plates/water/60141780.webp",
  "tiles/plates/water/688cb16f.webp",
];
const haveWater = WATER_PLATES.every((w) => existsSync(rel(w)));

test("a water plate really does carry a wall band (the gate is not vacuous)", { skip: skip || !haveWater }, () => {
  for (const path of WATER_PLATES) {
    const a = cropToArt(px(path), SHEETS.fw, SHEETS.fh);
    let top = 0;
    let band = 0;
    for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++) {
      if (a.data[i * 4 + 3] === 0) continue;
      if (SHEETS.libTop[i]) top++;
      else band++;
    }
    assert.equal(top, 924, `${path} top face`);
    assert.equal(band, 1088, `${path} wall band — if this is 0 the mask test proves nothing`);
  }
});

test("topFaceOnly drops the wall band and touches nothing else", { skip: skip || !haveWater }, () => {
  for (const path of WATER_PLATES) {
    const src = px(path);
    const a = cropToArt(src, SHEETS.fw, SHEETS.fh);
    const out = topFaceOnly(SHEETS, src);
    assert.equal(out.w, SHEETS.fw, "keeps plate geometry");
    assert.equal(out.h, SHEETS.fh, "keeps plate geometry");
    // the bottom surface row of each column, which the margin replicates
    const rep = new Set<number>();
    for (let x = 0; x < SHEETS.fw; x++) {
      let bottom = -1;
      for (let y = 0; y < SHEETS.fh; y++) if (SHEETS.libTop[y * SHEETS.fw + x]) bottom = y;
      if (bottom >= 0 && bottom + 1 < SHEETS.fh && a.data[(bottom * SHEETS.fw + x) * 4 + 3] > 0)
        rep.add((bottom + 1) * SHEETS.fw + x);
    }
    let kept = 0;
    let margin = 0;
    for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++) {
      if (SHEETS.libTop[i]) {
        // the top face survives byte for byte
        for (let c = 0; c < 4; c++) assert.equal(out.data[i * 4 + c], a.data[i * 4 + c], `${path} top px ${i} ch ${c}`);
        if (out.data[i * 4 + 3] > 0) kept++;
      } else if (rep.has(i)) {
        /* THE ONE ROW OF MARGIN, AND IT IS SURFACE, NOT WALL. A top-face-only
         * plate interlocks with its neighbour by exactly one row at dy=14 — the
         * only zero-slack seam in the game — so each column carries one more
         * row, copied from ITS OWN bottom surface pixel. Copying the plate's
         * next row instead is copying the WALL BAND, which is what put 76
         * (76,138,152) texels per plate onto the sea as the maintainer's dark
         * dotted zigzag. This asserts the difference. */
        const src = i - SHEETS.fw;
        for (let c = 0; c < 4; c++) assert.equal(out.data[i * 4 + c], a.data[src * 4 + c], `${path} margin px ${i} ch ${c}`);
        margin++;
      } else {
        // and NOTHING else outside it does — render3's `out = zeros; out[top] = a[top]`
        for (let c = 0; c < 4; c++) assert.equal(out.data[i * 4 + c], 0, `${path} wall px ${i} ch ${c}`);
      }
    }
    assert.equal(kept, 924, `${path} keeps its whole top face`);
    assert.equal(margin, 64, `${path} carries one margin row per column`);
    // NO WALL PIXEL SURVIVES ANYWHERE: every out-of-mask texel is a byte-exact
    // copy of the surface texel directly above it.
    for (const i of rep) {
      const src = i - SHEETS.fw;
      assert.ok(SHEETS.libTop[src], `${path} margin ${i} must copy a top-face texel`);
    }
  }
});

test("a top-only plate never shares a texture key with the full tile", { skip }, () => {
  const full = { kind: "plate", path: "tiles/plates/water/aa3287b9.webp" };
  const top = { ...full, topOnly: true };
  assert.notEqual(plateKey(top, "water"), plateKey(full, "water"), "same key = the full tile served for water");
  assert.notEqual(plateSourceId(top, "water"), plateSourceId(full, "water"), "same content id = a boundary built from the wrong pixels");
  // and a conformed one, whose wall band the conform REPAINTS
  const cf = { kind: "conform", path: "tiles/plates/water/aa3287b9.webp" };
  assert.notEqual(plateKey({ ...cf, topOnly: true }, "water"), plateKey(cf, "water"));
});

// WHY WATER MUST DRAW ITS SET AND NOT THE FLAT DIAMOND. `flat_tile`'s diamond
// TILES, with zero holes. It wears `sheets.libTop` — the same top-face mask a
// real plate's top wears, 29 rows overlapping their neighbours by one — because
// water is NOT a fallback path: `water` ships `base_tiles: []` and has no
// base_candidates set, so every water cell on the map paints this diamond. The
// old hand-derived `trunc(DX*(1-|y-DY|/DY))` formula left a regular diagonal
// lattice of single-pixel holes (252 px per 100x100 of sea, 2.5%, the dark page
// ground through every one) — the maintainer's "zigzag pattern at the tile edge
// on all water tiles", and before that the "visible edges" on the sea and the
// dark line along the shore. render3 draws a liquid as top_face_only(surface())
// — real plates, whole silhouettes, no holes — and the client now matches it.
test("the flat liquid diamond TILES the sea with no holes", { skip }, () => {
  const d = liquidDiamond([255, 255, 255], SHEETS);
  const W = 400;
  const H = 400;
  const cov = new Int16Array(W * H);
  const ox = 200;
  const oy = 60;
  for (let gy = 0; gy < 14; gy++)
    for (let gx = 0; gx < 14; gx++) {
      const sx = ox + (gx - gy) * DX - DX;
      const sy = oy + (gx + gy) * DY;
      if (sx < 0 || sy < 0 || sx + d.w > W || sy + d.h > H) continue;
      for (let y = 0; y < d.h; y++)
        for (let x = 0; x < d.w; x++)
          if (d.data[(y * d.w + x) * 4 + 3] > 0) cov[(sy + y) * W + sx + x]++;
    }
  let holes = 0;
  for (let y = 150; y < 250; y++) for (let x = 150; x < 250; x++) if (cov[y * W + x] === 0) holes++;
  assert.equal(holes, 0, "a sea of these diamonds shows no page ground through it");
  // The widest row is where it always was, so switching the mask moved no water.
  let widest = -1;
  let best = -1;
  for (let y = 0; y < d.h; y++) {
    let n = 0;
    for (let x = 0; x < d.w; x++) if (d.data[(y * d.w + x) * 4 + 3] > 0) n++;
    if (n > best) { best = n; widest = y; }
  }
  assert.equal(widest, TOP_Y + DY, "the diamond still hangs from TOP_Y");
  assert.equal(best, 2 * DX, "and its widest row still spans the whole tile");
});

/* AND NO MARGIN ROW ON A BOUNDARY, unlike a liquid's top face: a boundary paints
 * over a cell that has already painted its own top AND wall, so there is no hole
 * to fill and an extra row would bleed the blend one pixel into the tile in
 * front. The liquid path keeps its margin — that is what fixed the sea. */
test("topFaceOnly's margin row is opt-out, and the liquid default keeps it", { skip: skip || !haveWater }, () => {
  const src = px(WATER_PLATES[0]);
  const withM = topFaceOnly(SHEETS, src);
  const without = topFaceOnly(SHEETS, src, { margin: false });
  let m = 0;
  let n = 0;
  for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++) {
    if (SHEETS.libTop[i]) continue;
    if (withM.data[i * 4 + 3] > 0) m++;
    if (without.data[i * 4 + 3] > 0) n++;
  }
  assert.equal(m, 64, "the default carries one margin texel per column");
  assert.equal(n, 0, "margin:false carries none");
  // and the default is byte-identical to what shipped for the sea
  for (let i = 0; i < SHEETS.fw * SHEETS.fh; i++)
    if (SHEETS.libTop[i]) for (let ch = 0; ch < 4; ch++) assert.equal(withM.data[i * 4 + ch], without.data[i * 4 + ch]);
});

/* THE COMPOSE BUDGET — the whole contract, because getting any half of it wrong
 * is either a freeze or a wrong picture.
 *
 * A composition costs 6.0-9.6 ms on the maintainer's phone and a fresh ground
 * window around the spawn needs 128-287 of them, which is the 1,276 ms frame in
 * his beacon. The budget bounds how many START per frame. What it must never do
 * is refuse a key that already exists (the ground would flicker between plate
 * and transition as the camera moved) or refuse a PLATE (a boundary falls back
 * to the plain plate it replaces — the pre-3.0 hard edge, never a hole — while
 * a plate has no fallback at all and the cell would draw nothing). */
test("the compose budget refuses NEW boundaries, never a cache hit", { skip }, () => {
  const cases = (F.boundary as any[]).slice(0, 3);
  const fx = fakeTextures();
  for (const c of cases) {
    fx.put(artKey(c.a.path), px(c.a.path));
    fx.put(artKey(c.b.path), px(c.b.path));
  }
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  const bOf = (c: any) => ({ maskFrame: c.frame, a: c.a.ground, b: c.b.ground, plateA: c.a, plateB: c.b } as any);

  // A budget of 0 is spent before the first composition, so nothing new builds.
  T.armCompose(0);
  assert.equal(T.boundary(bOf(cases[0])), null, "a new boundary is refused");
  assert.equal(T.stats.built, 0, "and nothing was rasterised");
  assert.equal(T.stats.deferred, 1, "the refusal is counted");

  // Unbudgeted, the SAME boundary composes — so the refusal was the budget and
  // not a broken input, and the deferral is recoverable.
  T.armCompose(Infinity);
  const key = T.boundary(bOf(cases[0]));
  assert.ok(key, "unbudgeted, it composes");
  assert.equal(T.stats.built, 1);
  assert.equal(T.stats.builtBoundary, 1, "and is counted as a boundary build");

  // Spent again, an ALREADY COMPOSED key is still answered — free, and the
  // picture must not flicker.
  T.armCompose(0);
  assert.equal(T.boundary(bOf(cases[0])), key, "a cache hit is never refused");
  assert.equal(T.stats.deferred, 1, "and is not counted as a deferral");

  // A wall-clock budget is spent by the work itself: one composition costs more
  // than 0 ms, so an allowance of 0.000001 buys exactly the first one.
  // A FRESH texture manager: sharing `fx` would hand T2 the composition T
  // already registered, so it would spend nothing and defer nothing.
  const fx2 = fakeTextures();
  for (const c of cases) {
    fx2.put(artKey(c.a.path), px(c.a.path));
    fx2.put(artKey(c.b.path), px(c.b.path));
  }
  const T2 = new Tiles3Textures({ textures: fx2.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  T2.armCompose(1e-6);
  assert.ok(T2.boundary(bOf(cases[0])), "the first composition always starts");
  assert.equal(T2.boundary(bOf(cases[1])), null, "the next is deferred");
  assert.equal(T2.stats.built, 1, "exactly one composition was afforded");
});

test("the compose budget never refuses a PLATE — a plate has no fallback", { skip }, () => {
  const c: any = (F.boundary as any[])[0];
  const fx = fakeTextures();
  fx.put(artKey(c.a.path), px(c.a.path));
  const T = new Tiles3Textures({ textures: fx.man, sheets: SHEETS, groundTypes: GT, canvas: fakeCanvas });
  T.armCompose(0);
  const key = T.plate(c.a, c.a.ground);
  assert.ok(key, "a plate composes with the budget fully spent");
  assert.equal(T.stats.deferred, 0, "and no deferral is recorded");
});

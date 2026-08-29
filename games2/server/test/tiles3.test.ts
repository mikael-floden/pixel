// ============================================================================
// TILES3 — the ground-type -> art resolution, proven against render3 itself
// ============================================================================
//
// A `pixel-maps3/world@1` document stores SEMANTICS ONLY; the art is resolved at
// draw time. client/src/tiles3.ts is that resolution, and this is the gate that
// keeps it honest, because "plausible" is the failure mode here: a hash one
// operation off, a region id keyed on (min x, min y) instead of the lexicographic
// minimum, a member string re-parsed instead of read out of tiles/resolve.json —
// every one of those produces a world that renders beautifully and is simply not
// the world maps2 draws. Nothing crashes. You find out in a screenshot.
//
// So the port is checked, cell for cell, against a fixture GENERATED OUT OF
// render3.py by games2/scripts/tiles3-fixture.py: region, set, member, art path,
// fade, boundary index and plate pair, wall stack and every paste y. Two windows
// of the real 512x512 world, chosen for what they force the renderer to decide
// (the bay: 10 of 13 grounds, 7-storey cliffs, a house under a roof deck; the
// diagonal patch: the only place carrying lattice indices 6 and 9).
//
// SKIPPED, NOT FAILED, WHEN THE DATA IS ABSENT. The deploy workflow's test job
// sparse-checks-out games2 + characters2 + maps2/worlds + live, so neither
// maps2/worlds3 nor tiles/ is there; the same guard world3.test.ts uses applies.
// This proof runs in a full checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Tiles3,
  viewFromDoc,
  computeRegions,
  regionAt,
  REGION_CHUNK,
  measureStoreyPitch,
  isoFrame,
  setsFor,
  pickSet,
  pickMemberIndex,
  fnv1a,
  pickWeighted,
  lcg,
  hexRGB,
  WALL,
  TOP_Y,
  DY,
  TILE,
  PLATE_H,
  type BaseSet,
  type TileArt,
  type Tiles3Cell,
  type World3View,
} from "../../client/src/tiles3";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgRGBA } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const FIXTURE = join(HERE, "fixtures", "tiles3-parity.json");
const rel = (p: string) => join(REPO, p);

// Every document the resolver reads, exactly as its own domain publishes it.
const NEEDS = [
  "maps2/worlds3/the_game/world.json",
  "tiles/resolve.json",
  "tiles/ground_types.json",
  "tiles/patterns/index.json",
  "tiles/review/manifest.json",
  "tiles/fades/index.json",
  "tiles/slopes/index.json",
  "live/tuning/base_tile_sets.json",
  "live/tuning/base_tiles.json",
  "live/tuning/tile_walls.json",
  "live/tuning/top_walls.json",
  "live/tuning/tile_tops.json",
  "live/feedback/tiles.json",
];
const MISSING = [FIXTURE, ...NEEDS.map(rel)].filter((p) => !existsSync(p));
const load = (p: string): any => JSON.parse(readFileSync(rel(p), "utf8"));

const F: any = MISSING.length ? null : JSON.parse(readFileSync(FIXTURE, "utf8"));
const doc: any = F ? load(F.world.path) : null;
const P: string[] = F ? F.paths : [];
const C: any = F ? F.invariants.constants : null;

/* The palette guard render3 runs over a fade tile's own pixels: the 80th
 * percentile of each opaque pixel's distance to the NEARER of the two grounds'
 * palette tops, over the top diamond only, rejected above 78. It kills the
 * wrong-green sets (a lime square on a dark meadow) while keeping the soil
 * sets' honest shading range. A pure module cannot look at pixels, so it is
 * injected — and here it is the real thing, decoded from the real art, not the
 * fixture's answer handed back to itself. */
function fadeGuard(groundTypes: Record<string, any>) {
  const cache = new Map<string, boolean>();
  return (file: string, field: string, other: string): boolean => {
    const key = `${file}|${field}|${other}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const { width, height, data } = imgRGBA(rel(file)) as {
      width: number;
      height: number;
      data: Uint8Array;
    };
    const ca = hexRGB(groundTypes[field].palette.top);
    const cb = hexRGB(groundTypes[other].palette.top);
    const near: number[] = [];
    // The wall of a fade tile is explicitly meaningless, so only the top diamond
    // (plus the 2px the crop keeps) is classified.
    const rows = Math.min(height, TOP_Y + 2 * DY + 2);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i + 3] <= 0) continue;
        let da = 0;
        let db = 0;
        for (let c = 0; c < 3; c++) {
          da = Math.max(da, Math.abs(data[i + c] - ca[c]));
          db = Math.max(db, Math.abs(data[i + c] - cb[c]));
        }
        near.push(Math.min(da, db));
      }
    let ok = true;
    if (near.length) {
      near.sort((a, b) => a - b);
      const q = 0.8 * (near.length - 1);
      const lo = Math.floor(q);
      const hi = Math.ceil(q);
      ok = near[lo] + (near[hi] - near[lo]) * (q - lo) <= 78;
    }
    cache.set(key, ok);
    return ok;
  };
}

/** IS THIS SLOPE TILE THE 64x46 THE FRAME REQUIRES? render3 falls back to the
 *  flat plate for a mis-sized publication rather than masking a 30-row tile with
 *  a 46-row silhouette — the slope library has shipped 122 short tiles before.
 *  A pure module cannot measure, so the real measurement is injected here. */
function slopeGuard() {
  const cache = new Map<string, boolean>();
  return (file: string): boolean => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      const { width, height } = imgRGBA(rel(file)) as { width: number; height: number };
      ok = width === TILE && height === PLATE_H;
    } catch {
      ok = false;
    }
    cache.set(file, ok);
    return ok;
  };
}

/** Alpha > 128 — palette_snap's threshold, one step stricter than imagelib's. */
function opaqueOf(path: string): { w: number; h: number; op: (x: number, y: number) => boolean } {
  const { width, height, data } = imgRGBA(rel(path)) as {
    width: number;
    height: number;
    data: Uint8Array;
  };
  return { w: width, h: height, op: (x, y) => data[(y * width + x) * 4 + 3] > 128 };
}

function build(): { t: Tiles3; pitch: number; groundTypes: Record<string, any> } {
  const groundTypes = load("tiles/ground_types.json").grounds;
  const base = {
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: load("tiles/resolve.json"),
    groundTypes,
    patterns: load("tiles/patterns/index.json"),
    review: load("tiles/review/manifest.json"),
    feedback: load("live/feedback/tiles.json").entries,
    wallOverrides: load("live/tuning/tile_walls.json").overrides,
    basePromotions: load("live/tuning/base_tiles.json").overrides,
    fades: load("tiles/fades/index.json"),
    slopes: load("tiles/slopes/index.json"),
    topWallOverrides: load("live/tuning/top_walls.json").overrides,
    topOverrides: load("live/tuning/tile_tops.json").overrides,
    fadeGuard: fadeGuard(groundTypes),
    slopeGuard: slopeGuard(),
    warn: () => {},
  };
  // THE PITCH IS MEASURED, from the very tile render3 measures it from, and only
  // then handed to the resolver. Hardcoding 16 or 17 here would defeat the
  // point: 17 is what the doc says and 15 is what the art does.
  const probe = new Tiles3({ ...base, storeyPitch: 1 });
  const art = probe.overTile("grey_stone", "grey_stone");
  const { w, h, op } = opaqueOf(art.path as string);
  const pitch = measureStoreyPitch(w, h, op) || 16;
  return { t: new Tiles3({ ...base, storeyPitch: pitch }), pitch, groundTypes };
}

const skip = (name: string) =>
  test(name, () => {
    assert.ok(true);
  });

if (MISSING.length) {
  skip(`tiles3 parity SKIPPED — not in this checkout: ${MISSING.map((m) => m.replace(REPO + "/", "")).join(", ")}`);
}

/* -- the pick, against the wiki's own reference ----------------------------- */

test("the hash is the wiki's hash, to the bit", { skip: !!MISSING.length }, async () => {
  for (const [s, want] of F.invariants.fnv1a_vectors) assert.equal(fnv1a(s), want, `fnv1a(${s})`);
  for (const [w, u, want] of F.invariants.pick_weighted_vectors)
    assert.equal(pickWeighted(w, u), want, `pickWeighted(${JSON.stringify(w)}, ${u})`);
  for (const [seed, want] of F.invariants.lcg_vectors)
    assert.ok(Math.abs(lcg(seed >>> 0)() - want) < 1e-15, `lcg(${seed})`);

  // The normative spec ships its OWN vectors, and the wiki is in a full checkout:
  // run those too, plus the reference functions themselves over live data. A port
  // that agrees with a fixture but not with basesets.mjs would still make the
  // ground disagree between the game and the wiki's preview.
  const specPath = join(REPO, "wiki", "lib", "basesets.mjs");
  if (!existsSync(specPath)) return;
  const spec: any = await import(pathToFileURL(specPath).href);
  for (const [s, want] of spec.TEST_VECTORS.fnv1a) assert.equal(fnv1a(s), want);
  for (const [w, u, want] of spec.TEST_VECTORS.pickWeighted) assert.equal(pickWeighted(w, u), want);
  const bts = load("live/tuning/base_tile_sets.json");
  let checked = 0;
  for (const ground of Object.keys(bts.grounds)) {
    assert.deepEqual(
      setsFor(bts, ground).map((s: BaseSet) => ({
        id: s.id,
        weight: s.weight,
        members: s.members,
      })),
      spec.setsFor(bts, ground).map((s: any) => ({
        id: s.id,
        weight: s.weight,
        members: s.members,
      })),
      `setsFor(${ground})`,
    );
    for (let i = 0; i < 40; i++) {
      const region = `${ground}@${i * 7},${i * 13 + 3}`;
      const mine = pickSet(setsFor(bts, ground), ground, region);
      assert.equal(mine.id, spec.pickSet(bts, ground, region).id, `pickSet(${ground},${region})`);
      const mi = pickMemberIndex(mine, i * 5, i * 11);
      const ref = spec.pickMember(spec.setsFor(bts, ground).find((s: any) => s.id === mine.id), i * 5, i * 11);
      assert.equal(mi < 0 ? "clean" : mine.members[mi].kind, ref.kind);
      if (mi >= 0 && mine.members[mi].kind === "tile")
        assert.equal((mine.members[mi] as any).tile, ref.tile);
      checked++;
    }
  }
  assert.ok(checked >= 400, "the cross-check must actually cover the live sets");
});

/* -- the fixture is the one render3 wrote ----------------------------------- */

test("the fixture matches the world on disk", { skip: !!MISSING.length }, () => {
  assert.equal(F.schema, "pixel-games2/tiles3-parity@1");
  assert.equal(F.reference, "maps2/pipeline/render3.py");
  const sha = createHash("sha256").update(readFileSync(rel(F.world.path))).digest("hex");
  assert.equal(sha, F.world.sha256, "the fixture was generated from a different world.json");
  assert.equal(doc.schema, "pixel-maps3/world@1");
  assert.equal(doc.size.w, 512);
});

/* -- the measured storey pitch ---------------------------------------------- */

test("the storey pitch is MEASURED off the art, and it is not 17", { skip: !!MISSING.length }, () => {
  const { pitch } = build();
  assert.equal(pitch, C.storey_pitch, "the measured pitch must be render3's");
  assert.equal(pitch, 15);
  assert.notEqual(pitch, WALL, "17 is the doc's number; it leaks a row of the floor below");
  assert.notEqual(pitch, 16, "16 is render3's fallback for an unmeasurable tile, not the answer");
});

/* -- the whole window, cell for cell ---------------------------------------- */

const paths = (i: number | undefined | null) => (i === undefined || i === null ? null : P[i]);

function assertTile(e: any, mine: TileArt, where: string): void {
  assert.equal(mine.role, e.role, `${where} role`);
  if (e.key !== undefined) assert.equal(mine.key, e.key, `${where} key`);
  if (e.top !== undefined) assert.equal(mine.top, e.top, `${where} top`);
  if (e.side !== undefined) assert.equal(mine.side, e.side, `${where} side`);
  if (e.ground !== undefined) assert.equal(mine.ground, e.ground, `${where} ground`);
  if (e.path !== undefined) assert.equal(mine.path, paths(e.path), `${where} path`);
  /* THE BORROWED WALL. `top_only` in tile_walls.json and `wall` in
   * top_walls.json only mean anything together: the tile keeps its top and wears
   * the face he named. Naming the wrong one is invisible to a path check —
   * `path` is still the tile's own art — so it is pinned separately. */
  if (e.borrowed) {
    assert.ok(mine.borrowedWall, `${where} must borrow a wall`);
    assert.equal(mine.borrowedWall.key, e.borrowed.key, `${where} borrowed wall key`);
    assert.equal(mine.borrowedWall.path, paths(e.borrowed.path), `${where} borrowed wall art`);
  } else {
    assert.equal(mine.borrowedWall, undefined, `${where} borrows a wall render3 does not`);
  }
  if (e.painted !== undefined) {
    assert.equal(mine.painted, e.painted, `${where} painted`);
    assert.deepEqual(mine.topRGB, e.top_rgb, `${where} top colour`);
  }
  assert.equal(mine.w, e.w, `${where} w`);
  assert.equal(mine.h, e.h, `${where} h`);
}

/** The fixture names a plate by what plate_img() actually returned: a published
 *  plate, a plate CONFORMED here from art the plate library does not cover, or
 *  the ground's clean plate. The port has to land on the same one. */
function assertPlate(e: any, kind: string, path: string, where: string): void {
  if (e.kind === "plate") {
    assert.equal(kind, "plate", `${where} kind`);
    assert.equal(path, paths(e.path), `${where} path`);
  } else if (e.kind === "conformed") {
    assert.equal(kind, "conform", `${where} kind`);
    assert.equal(path, paths(e.src), `${where} source art`);
  } else {
    assert.equal(kind, "clean", `${where} kind`);
    assert.equal(path, paths(e.path), `${where} path`);
  }
}

test("every cell of every window resolves to render3's art", { skip: !!MISSING.length }, () => {
  const { t } = build();
  let matched = 0;
  let total = 0;
  const seen = { plate: 0, slope: 0, fade: 0, detail: 0, boundary: 0, folded: 0, liquid: 0, wall: 0, unexposed: 0, deck: 0 };

  for (const w of F.windows) {
    const view: World3View = viewFromDoc(doc, { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
    const out = t.resolveWindow(view);

    // The frame first: every paste y below is measured from it.
    assert.equal(out.frame.ox, w.origin.ox, `${w.name} ox`);
    assert.equal(out.frame.oy, w.origin.oy, `${w.name} oy`);
    assert.equal(out.frame.pitch, w.origin.storey_pitch, `${w.name} pitch`);
    assert.equal(view.maxLevel, w.origin.world_max_level, `${w.name} world max level`);
    assert.deepEqual(out.frame.canvas, w.origin.canvas, `${w.name} canvas`);
    /* `region_ids` is every region the fixture ASKED FOR, which includes the
     * other ground's region on each half of a boundary; `regions.ids` is the
     * regions the window's own cells live in. The second is a subset of the
     * first, and must be exactly the set the cells name. */
    assert.deepEqual(
      [...out.regions.ids].sort(),
      [...new Set(w.cells.map((c: any) => w.region_ids[c.r]))].sort(),
      `${w.name} region ids`,
    );
    for (const id of out.regions.ids) assert.ok(w.region_ids.includes(id), `${w.name}: ${id} unknown`);

    const byCell = new Map<string, Tiles3Cell>();
    for (const c of out.cells) byCell.set(`${c.x},${c.y}`, c);

    for (const c of w.cells) {
      total++;
      const at = `${w.name} (${c.x},${c.y})`;
      const mine = byCell.get(`${c.x},${c.y}`);
      assert.ok(mine, `${at} missing from the port's sweep`);
      assert.equal(mine.ground, c.g, `${at} ground`);
      assert.equal(mine.level, c.z, `${at} level`);
      assert.equal(mine.region, w.region_ids[c.r], `${at} region`);
      assert.equal(mine.sx, c.sx, `${at} sx`);
      assert.equal(mine.sy, c.sy, `${at} sy`);

      /* THE WALL COLUMN, and its absence. A raised cell with no exposed face
       * carries no column at all in render3 — it draws one surface, which is
       * what "field" means here. */
      if (c.w) {
        seen.wall++;
        const wl = mine.wall;
        assert.ok(wl, `${at} should be a wall column`);
        assert.equal(mine.kind, "wall", `${at} kind`);
        assert.equal(wl.side, c.w.side, `${at} wall side`);
        assert.equal(wl.frontLow, c.w.fl, `${at} front_low`);
        assert.equal(wl.fx, c.w.fx, `${at} face foot x`);
        assert.equal(wl.fy, c.w.fy, `${at} face foot y`);
        assert.equal(wl.over, c.w.over, `${at} walls[] override`);
        assert.equal(wl.capped, c.w.capped, `${at} capped`);
        assert.equal(wl.midGround, c.w.midg, `${at} storey ground`);
        assert.equal(wl.midGround, wl.side, `${at} the course is the WALL's side`);
        assertTile(F.tiles[c.w.cap], wl.cap, `${at} cap`);
        assertTile(F.tiles[c.w.mid], wl.mid, `${at} mid`);
        assert.equal(wl.stack.length, c.w.st.length, `${at} stack height`);
        c.w.st.forEach(([storey, ti, y]: [number, number, number], i: number) => {
          assert.equal(wl.stack[i].storey, storey, `${at} storey ${i}`);
          assert.equal(wl.stack[i].y, y, `${at} storey ${i} paste y`);
          assertTile(F.tiles[ti], wl.stack[i].tile, `${at} storey ${i} tile`);
        });
      } else {
        assert.equal(mine.wall, undefined, `${at} should not be a wall column`);
        assert.equal(mine.kind, "field", `${at} kind`);
        if (c.z > 0) seen.unexposed++;
      }

      /* THE SURFACE. Every one of them is 64x46 plate geometry pasted on the
       * cell's own top vertex, whatever produced it. */
      assert.ok(mine.art, `${at} surface`);
      assert.equal(mine.pasteY, c.py, `${at} paste y`);
      assert.equal(mine.art.h, c.ph, `${at} surface height`);
      assert.equal(mine.art.h, PLATE_H, `${at} a surface is plate geometry`);
      assert.equal(!!(mine.art as any).topOnly, !!c.top_only, `${at} top face only`);
      assert.equal(mine.dressed ?? true, c.dressed ?? true, `${at} dressed`);
      if (view.isLiquid(c.g)) {
        seen.liquid++;
        assert.ok(c.top_only, `${at} a liquid never shows a wall`);
        assert.equal(mine.boundary, undefined, `${at} no quad touching a liquid composes`);
      }

      // set / member / plate — the maintainer's pick, on EVERY cell now.
      assert.equal(mine.set, c.set, `${at} set`);
      assert.equal(mine.memberIndex, c.mi, `${at} member index`);
      const setDoc = F.invariants.base_tile_sets[c.g].find((s: any) => s.id === c.set);
      assert.ok(setDoc, `${at} set ${c.set} is not published for ${c.g}`);
      assert.equal(
        t.setsFor(c.g).find((s) => s.id === c.set)?.members.length,
        setDoc.members.length,
        `${at} member count`,
      );
      if (c.mi >= 0) {
        const m = setDoc.members[c.mi];
        const mm = t.setsFor(c.g).find((s) => s.id === c.set)!.members[c.mi];
        assert.equal(mm.kind, m.kind, `${at} member kind`);
        if (m.tile !== undefined) assert.equal((mm as any).tile, paths(m.tile), `${at} member`);
      }
      assert.ok(mine.plate, `${at} plate`);
      assertPlate(F.plates[c.p], mine.plate.kind, mine.plate.path, `${at} plate`);
      assert.equal(mine.plate.stale, false, `${at} resolved through the published data`);

      /* ...and what replaced it, in render3's own order: a slope replaces the
       * plate, a fade replaces either, a detail replaces what is left, and a
       * composed boundary replaces the lot. `srf` is the FINAL surface; the
       * picks below still happened even when a later one won. */
      const kind: string = c.srf;
      if (c.sl) {
        seen.slope++;
        assert.ok(mine.slope, `${at} slope`);
        assert.equal(mine.slope.index, c.sl.i, `${at} slope wang index`);
        assert.equal(mine.slope.dir, c.sl.dir, `${at} slope set`);
        assert.equal(mine.slope.file, paths(c.sl.t), `${at} slope tile`);
        if (kind === "slope") {
          assert.equal(mine.art.kind, "plate", `${at} a slope draws its own art`);
          assert.equal((mine.art as any).path, paths(c.sl.t), `${at} slope art`);
        }
      } else {
        assert.equal(mine.slope, undefined, `${at} the port graded a cell render3 does not`);
      }
      if (c.f) {
        seen.fade++;
        assert.equal(kind, "fade", `${at} a fade is the final surface`);
        assert.ok(mine.fade, `${at} fade`);
        assert.equal(mine.fade.other, c.f.o, `${at} fade other ground`);
        assert.equal(mine.fade.dist, c.f.d, `${at} fade ring`);
        assert.equal(mine.fade.poolKey, c.f.pool, `${at} fade pool`);
        assert.equal(mine.fade.index, c.f.i, `${at} fade index`);
        assert.ok(Math.abs(mine.fade.u - c.f.u) < 1e-12, `${at} fade roll`);
        assert.ok(Math.abs(mine.fade.v - c.f.v) < 1e-12, `${at} fade pick`);
        assert.equal(mine.fade.file, paths(c.f.t), `${at} fade tile`);
        assert.equal((mine.art as any).path, paths(c.f.t), `${at} draws the fade`);
        assert.equal(mine.art.kind, "conform", `${at} a fade is conformed, never cropped`);
      } else {
        assert.equal(mine.fade, undefined, `${at} no fade here`);
      }
      if (c.d) {
        seen.detail++;
        assert.equal(kind, "detail", `${at} a detail is the final surface`);
        assert.ok(mine.detail, `${at} detail`);
        assert.equal(mine.detail.index, c.d.i, `${at} detail index`);
        assert.equal(mine.detail.file, paths(c.d.t), `${at} detail tile`);
        assert.equal((mine.art as any).path, paths(c.d.t), `${at} draws the detail`);
        assert.equal(mine.art.kind, "conform", `${at} a detail is conformed`);
      } else {
        assert.equal(mine.detail, undefined, `${at} the port placed a detail render3 does not`);
      }
      if (c.b !== undefined) {
        seen.boundary++;
        assert.equal(kind, "boundary", `${at} a boundary is the final surface`);
        const fb = w.boundaries[c.b];
        const mb = mine.boundary;
        assert.ok(mb, `${at} boundary`);
        assert.equal(mb.x, fb.x, `${at} boundary x`);
        assert.equal(mb.y, fb.y, `${at} boundary y`);
        assert.equal(mb.index, fb.i, `${at} wang index`);
        assert.equal(mb.a, fb.a, `${at} side_a`);
        assert.equal(mb.b, fb.b, `${at} side_b`);
        assert.equal(mb.folded, fb.folded, `${at} three-ground fold`);
        if (fb.folded) seen.folded++;
        assert.equal(mb.setA, fb.seta, `${at} side_a set`);
        assert.equal(mb.memberA, fb.mia, `${at} side_a member`);
        assert.equal(mb.setB, fb.setb, `${at} side_b set`);
        assert.equal(mb.memberB, fb.mib, `${at} side_b member`);
        assertPlate(F.plates[fb.pa], mb.plateA.kind, mb.plateA.path, `${at} plate a`);
        assertPlate(F.plates[fb.pb], mb.plateB.kind, mb.plateB.path, `${at} plate b`);
        assert.equal(mb.sx, fb.sx, `${at} boundary sx`);
        assert.equal(mb.sy, fb.sy, `${at} boundary sy`);
        assert.equal(mb.pattern, F.invariants.masks.pattern, `${at} mask pattern`);
        assert.equal(mb.maskFrame! % 16, fb.i, `${at} mask frame`);
        assert.ok(F.invariants.masks.per_index[fb.i].true_px > 0, `${at} empty mask`);
        assert.notEqual(mb.index, 0, `${at} index 0 is not drawn`);
        assert.notEqual(mb.index, 15, `${at} index 15 is not drawn`);
        assert.equal(!!mb.topOnly, !!c.top_only, `${at} boundary top face only`);
      } else {
        assert.equal(mine.boundary, undefined, `${at} the port composed a boundary render3 does not`);
        if (kind === "plate") seen.plate++;
      }
      matched++;
    }
    assert.equal(out.cells.length, w.cells.length, `${w.name} cell count`);
    assert.equal(out.boundaries.length, w.boundaries.length, `${w.name} boundary count`);

    // Decks: the same stack machinery one level up, and the slab wears his set.
    assert.equal(out.decks.length, w.decks.length, `${w.name} deck cell count`);
    w.decks.forEach((fd: any, i: number) => {
      const md = out.decks[i];
      const at = `${w.name} deck (${fd.x},${fd.y})`;
      assert.equal(md.x, fd.x, `${at} x`);
      assert.equal(md.y, fd.y, `${at} y`);
      assert.equal(md.deck, fd.d, `${at} deck index`);
      assert.equal(md.ground, fd.ground, `${at} ground`);
      assert.equal(md.body, fd.body, `${at} body`);
      assert.equal(md.frontCovered, fd.front_covered, `${at} front covered`);
      assert.equal(md.lo, fd.lo, `${at} stack bottom`);
      assert.equal(md.sx, fd.sx, `${at} sx`);
      assertTile(F.tiles[fd.cap], md.cap, `${at} cap`);
      assertTile(F.tiles[fd.mid], md.mid, `${at} mid`);
      assert.equal(md.stack.length, fd.st.length, `${at} stack height`);
      fd.st.forEach(([storey, ti, y]: [number, number, number], j: number) => {
        assert.equal(md.stack[j].storey, storey, `${at} storey ${j}`);
        assert.equal(md.stack[j].y, y, `${at} storey ${j} paste y`);
        assertTile(F.tiles[ti], md.stack[j].tile, `${at} storey ${j} tile`);
      });
      assert.equal(md.surfaceSet, fd.srf_set, `${at} surface set`);
      assert.equal(md.surfaceMember, fd.srf_mi, `${at} surface member`);
      assertPlate(F.plates[fd.srf_p], md.surface.kind, md.surface.path, `${at} surface`);
      assert.equal(md.surfaceY, fd.srf_y, `${at} surface paste y`);
      seen.deck++;
    });
  }

  assert.equal(matched, total);
  assert.equal(total, F.windows.reduce((n: number, w: any) => n + w.cells.length, 0));
  // The fixture is only worth what it exercises: every art source must appear.
  for (const [k, n] of Object.entries(seen))
    if (k !== "folded") assert.ok(n > 0, `the fixture exercises no ${k} — it proves nothing about one`);
  assert.ok(seen.folded > 0, "no three-ground junction in the fixture");
  console.log(
    `tiles3 parity: ${matched} of ${total} cells match render3 ` +
      `(${seen.plate} plate, ${seen.slope} slope, ${seen.fade} fade, ${seen.detail} detail, ` +
      `${seen.boundary} boundary of which ${seen.folded} folded, ${seen.liquid} liquid, ` +
      `${seen.wall} wall columns, ${seen.unexposed} raised with no exposed face, ${seen.deck} deck cells)`,
  );
});

/* -- the region rule -------------------------------------------------------- */

test("a region is a 24-CELL CHUNK of one ground, not a connected component", { skip: !!MISSING.length }, () => {
  // The rule itself, to the character.
  assert.equal(REGION_CHUNK, F.invariants.constants.REGION_CHUNK);
  assert.equal(regionAt("grass", 0, 0), "grass@0,0");
  assert.equal(regionAt("grass", 23, 23), "grass@0,0");
  assert.equal(regionAt("grass", 24, 23), "grass@1,0");
  assert.equal(regionAt("snow", 380, 344), "snow@15,14");

  for (const w of F.windows) {
    const view = viewFromDoc(doc, { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
    const g = (x: number, y: number) =>
      x >= w.x0 && x < w.x1 && y >= w.y0 && y < w.y1 ? view.groundAt(x, y) : null;
    const r = computeRegions({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }, g);
    for (const id of r.ids) assert.ok(w.region_ids.includes(id), `${w.name}: ${id} unknown`);
    for (let y = w.y0; y < w.y1; y++)
      for (let x = w.x0; x < w.x1; x++) {
        const ground = view.groundAt(x, y);
        assert.equal(r.idAt(x, y), ground ? regionAt(ground, x, y) : "r0", `region at ${x},${y}`);
      }
    /* A CHUNK IS A LOCATION: it does not depend on the window it was computed
     * in, which is the whole reason a camera can stream without the ground
     * reshuffling. A component id does depend on it, and that is the bug. */
    const half = computeRegions(
      { x0: w.x0, y0: w.y0, x1: w.x0 + Math.floor((w.x1 - w.x0) / 2), y1: w.y1 },
      g,
    );
    for (let y = w.y0; y < w.y1; y++)
      for (let x = w.x0; x < w.x0 + Math.floor((w.x1 - w.x0) / 2); x++)
        assert.equal(half.idAt(x, y), r.idAt(x, y), `${w.name}: (${x},${y}) re-keyed by the window`);
  }
});

/* -- and the point of the region fix ---------------------------------------- */

test("the maintainer's set weights actually reach the map", { skip: !!MISSING.length }, () => {
  const bts = load("live/tuning/base_tile_sets.json");
  const view = viewFromDoc(doc);
  const cells = new Map<string, number>();
  const picked = new Map<string, Map<number, number>>();
  for (let y = 0; y < doc.size.h; y++)
    for (let x = 0; x < doc.size.w; x++) {
      const g = view.groundAt(x, y);
      if (!g) continue;
      cells.set(g, (cells.get(g) ?? 0) + 1);
      const id = pickSet(setsFor(bts, g), g, regionAt(g, x, y)).id;
      let per = picked.get(g);
      if (!per) picked.set(g, (per = new Map()));
      per.set(id, (per.get(id) ?? 0) + 1);
    }
  /* THE NUMBER THAT SAYS HIS TUNING IS LIVE. With connected components ONE set
   * painted 98.7% of the grass, 99.7% of the snow and 99.8% of the black_rock —
   * every other set he weighted was implemented and invisible. A ground with
   * more than one weighted set must now spread across them. */
  const lines: string[] = [];
  for (const [g, n] of [...cells].sort((a, b) => b[1] - a[1])) {
    const weighted = setsFor(bts, g).filter((s) => s.weight > 0).length;
    const per = picked.get(g) as Map<number, number>;
    const top = Math.max(...per.values());
    lines.push(`      ${g.padEnd(20)} ${String(n).padStart(6)} cells  ${per.size} of ${weighted} weighted sets  top set ${((100 * top) / n).toFixed(1)}%`);
    if (weighted > 1 && n >= 400)
      assert.ok(per.size > 1, `${g}: ${weighted} weighted sets and only one ever picked`);
    if (weighted > 2 && n >= 4000)
      assert.ok(top / n < 0.9, `${g}: one set still paints ${((100 * top) / n).toFixed(1)}% of the ground`);
  }
  console.log("    sets actually picked across the_game:\n" + lines.join("\n"));
});

/* -- the data, not a re-implementation -------------------------------------- */

test("a set member draws its TEXTURED art, and a gap in the index is reported", { skip: !!MISSING.length }, () => {
  const groundTypes = load("tiles/ground_types.json").grounds;
  const warnings: string[] = [];
  const stale = new Tiles3({
    baseTileSets: load("live/tuning/base_tile_sets.json"),
    memberResolve: { members: {} }, // a STALE index: it lists nothing
    groundTypes,
    patterns: load("tiles/patterns/index.json"),
    storeyPitch: C.storey_pitch,
    warn: (m) => warnings.push(m),
  });
  // With no review manifest there is no textured art to prefer, so the plate
  // form falls back to the published plate for the cell's ground...
  const a = stale.memberArt("grass", "tiles/grass__over__grass/b421e18e");
  assert.equal(a.kind, "plate");
  assert.equal(a.path, "tiles/plates/grass/b421e18e.webp");
  assert.equal(a.stale, true);
  // ...and the file form to the art itself, which still needs conforming.
  const b = stale.memberArt("grass", "tiles/base_candidates/grass/grass__to__lava__a14_s1.webp");
  assert.equal(b.kind, "conform");
  assert.equal(b.path, "tiles/base_candidates/grass/grass__to__lava__a14_s1.webp");
  assert.equal(b.stale, true);
  // A member matching neither form draws clean — and SAYS SO. render3 makes this
  // fatal for the same reason: clean.webp is a real file, so a silent
  // fall-through passes every existence check and only looks "a bit flat".
  const c = stale.memberArt("grass", "tiles/grass__over__grass/not-a-hash");
  assert.equal(c.kind, "clean");
  assert.equal(stale.stats.staleMembers, 3);
  assert.equal(stale.stats.unresolvedMembers, 1);
  assert.ok(warnings.some((m) => m.includes("STALE")));
  assert.ok(warnings.some((m) => m.includes("draw CLEAN")));

  // And with the real data: every member of every set the world can reach
  // resolves, with nothing falling back — and a REVIEW-KEY member resolves to
  // the candidate's own TEXTURED art, never to tiles/plates/<g>/<key8>.webp.
  // That plate is the same tile flattened to the clean colour by design; using
  // it painted 236 of his 340 members flat, which is what tiles/resolve.json's
  // `forms` still tells a consumer to do.
  const { t } = build();
  const man = load("tiles/review/manifest.json");
  const textured = new Map<string, string>();
  for (const cell of Object.values<any>(man.cells))
    for (const c of cell.candidates) if (c.textured) textured.set(c.key, c.textured);
  let members = 0;
  let fromTextured = 0;
  for (const ground of Object.keys(load("live/tuning/base_tile_sets.json").grounds))
    for (const s of t.setsFor(ground))
      for (const m of s.members)
        if (m.kind === "tile") {
          const art = t.memberArt(ground, m.tile);
          assert.equal(art.stale, false, `${ground} ${m.tile}`);
          assert.ok(existsSync(rel(art.path)), `${art.path} does not exist on disk`);
          const tex = textured.get(m.tile);
          if (tex) {
            assert.equal(art.kind, "conform", `${ground} ${m.tile} must conform its own art`);
            assert.equal(art.path, tex, `${ground} ${m.tile} must draw its textured pass`);
            fromTextured++;
          }
          members++;
        }
  assert.equal(t.stats.staleMembers, 0);
  assert.equal(t.stats.unresolvedMembers, 0);
  assert.ok(members >= 300, `only ${members} members checked`);
  assert.ok(fromTextured >= 200, `only ${fromTextured} members came from their textured art`);
});

/* -- the pools -------------------------------------------------------------- */

test("the detail, fade and slope pools are render3's pools", { skip: !!MISSING.length }, () => {
  const { t } = build();
  for (const [ground, want] of Object.entries<any>(F.invariants.detail_pools))
    assert.deepEqual(
      t.detailPool(ground),
      want.map((i: number) => P[i]),
      `detail pool for ${ground}`,
    );
  // Details ARE reachable now: since `surface` took over every cell, the roll
  // happens on any surface that is not a fade or a boundary.
  assert.equal(F.invariants.detail_pool_reachable, true);

  // A fade pool is APPROVED ONLY, in pct order, and carries his rating — the
  // rating is what weights the pick, so a pool that agrees on files and not on
  // ratings still draws a different tile.
  for (const w of F.windows)
    for (const [key, want] of Object.entries<any>(w.fade_pools)) {
      const [field, other] = key.split("|");
      assert.deepEqual(
        t.fadePool(field, other).map((f) => [f.file, f.pct, f.rating]),
        want.map(([i, pct, rating]: [number, number, number]) => [P[i], pct, rating]),
        `fade pool ${key}`,
      );
    }
  assert.equal(t.stats.unguardedFadePools, 0, "the palette guard must have been supplied");

  // The slope library, filtered exactly as render3 filters it: complete sets
  // with at least one tile he approved, in dir order, and the approved indices.
  const grounds = Object.keys(F.invariants.slope_sets);
  assert.ok(grounds.length >= 10, `only ${grounds.length} grounds carry a usable slope set`);
  for (const [ground, want] of Object.entries<any>(F.invariants.slope_sets)) {
    assert.deepEqual(
      t.slopeSets(ground).map((st) => ({
        dir: st.dir,
        approved: [...Array(16).keys()].filter((i) => t.slopeApproved(st.dir, i)),
      })),
      want,
      `slope sets for ${ground}`,
    );
  }
  // A ground he has judged NOTHING for draws no slope at all — the whole point
  // of the filter (light_soil carries every road on the map and has no set).
  for (const ground of Object.keys(load("tiles/ground_types.json").grounds))
    if (!F.invariants.slope_sets[ground])
      assert.equal(t.slopeTile(ground, 7, 100, 100), null, `${ground} drew an unapproved slope`);
});

/* -- the geometry the renderer will paste with ------------------------------ */

test("the iso frame and the plate/tile offsets are render3's", { skip: !!MISSING.length }, () => {
  const w = F.windows[0];
  const f = isoFrame({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }, w.origin.world_max_level, C.storey_pitch);
  // oy is headroom above the tallest column in the WHOLE doc and uses WALL, not
  // the measured pitch — it is not a stacking step.
  assert.equal(f.oy, w.origin.world_max_level * WALL + 24);
  assert.notEqual(f.oy, w.origin.world_max_level * C.storey_pitch + 24);
  assert.equal(C.TILE, TILE);
  assert.equal(C.PLATE_H, PLATE_H);
  assert.equal(C.TOP_Y, TOP_Y);
  assert.equal(C.DY, DY);
  // EVERY surface is 46px plate geometry and lands ON the cell's top vertex —
  // a plate, a slope, a conformed fade or detail, a composed boundary alike.
  // The 64px review tiles are the wall stack, and those hang from TOP_Y.
  for (const c of F.windows[0].cells) {
    assert.equal(c.ph, PLATE_H, `(${c.x},${c.y}) surface height`);
    assert.equal(c.py, c.sy, `(${c.x},${c.y}) surface paste y`);
  }
  const stacked = F.windows[0].cells.find((c: any) => c.w);
  const [, ti, sy] = stacked.w.st[0];
  assert.equal(F.tiles[ti].h, TILE);
  assert.equal(sy, stacked.sy + (stacked.z - stacked.w.st[0][0]) * C.storey_pitch - TOP_Y);
});

/* -- the whole world, not just the sampled windows -------------------------- */

test("the entire 512x512 world resolves with no fallback and no missing art", { skip: !!MISSING.length }, () => {
  const { t } = build();
  const started = Date.now();
  const out = t.resolveWindow(viewFromDoc(doc));
  // Every non-void cell of the doc, and nothing else.
  let solid = 0;
  for (let y = 0; y < doc.size.h; y++) for (let x = 0; x < doc.size.w; x++) if (doc.ground[y][x] >= 0) solid++;
  assert.equal(out.cells.length, solid);
  assert.ok(out.regions.ids.length > 0);

  // THE SILENT-FLAT GATE, the port's half. render3 makes an unresolved member
  // FATAL because clean.webp is a real file: every existence check passes and
  // the only symptom is a world that looks flatter than it is — 30.6% of
  // members, invisible for two weeks. Zero here means zero, world-wide.
  assert.equal(t.stats.staleMembers, 0, "tiles/resolve.json does not cover the world");
  assert.equal(t.stats.unresolvedMembers, 0, "a member drew clean");
  assert.equal(t.stats.unguardedFadePools, 0);

  // Every file the world asks for must be on disk — a resolver that names art
  // nobody published is a 404 per cell in the deployed game.
  const files = new Set<string>();
  for (const c of out.cells) {
    if (c.plate) files.add(c.plate.path);
    if (c.fade) files.add(c.fade.file);
    if (c.art && "path" in c.art) files.add(c.art.path);
    for (const s of c.wall?.stack ?? []) if (s.tile.path) files.add(s.tile.path);
  }
  for (const b of out.boundaries) {
    files.add(b.plateA.path);
    files.add(b.plateB.path);
  }
  for (const d of out.decks) for (const s of d.stack) if (s.tile.path) files.add(s.tile.path);
  const gone = [...files].filter((f) => !existsSync(rel(f)));
  assert.deepEqual(gone, [], "art the world resolves to but nobody published");
  console.log(
    `tiles3 world: ${out.cells.length} cells, ${out.regions.ids.length} regions, ` +
      `${out.boundaries.length} boundaries, ${out.decks.length} deck cells, ` +
      `${files.size} distinct art files, all present (${Date.now() - started} ms)`,
  );
});

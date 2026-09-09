// ============================================================================
// SCENERY LIGHT — the shape map a scenery piece is lit with, per texel
// ============================================================================
//
// client/src/scenerylight.ts turns a sprite's alpha silhouette and its
// published hitbox into a pseudo-normal + depth raster the scenery-lit
// pipeline samples beside the art (an ellipse hitbox → a surface of revolution
// whose radius is the per-row silhouette; a rect → a box whose visible faces
// turn with the placement's facing; hflip = the same map read in a mirror).
// The failure mode is silent: a wrong sign lights the far side of every tree,
// a wrong frame turns a bed's front into its side, and the game keeps drawing.
// So the geometry is pinned on synthetic silhouettes whose answers are known.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildShapeMap,
  decodeShape,
  shapeMapKey,
  shapeLightTerm,
  alphaRowProfile,
  smoothProfile,
  ShapeMapBuilder,
  SHAPE_DEPTH_CELLS,
  SHAPE_ZW_ATT,
  SHAPE_AXIS_MIN,
  type ShapeHitbox,
  type ShapeScale,
} from "../../client/src/scenerylight";
import { rectGroundRot } from "@nangijala/shared";

/** maps3 draw geometry (dx 32, dy 14, lh 15) at draw scale 1. */
const SC: ShapeScale = { px2cell: 1 / (32 * Math.SQRT2), py2cell: 1 / (14 * Math.SQRT2), px2lvl: 1 / 15 };

function blank(w: number, h: number) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}
function disc(px: { w: number; h: number; data: Uint8ClampedArray }, cx: number, cy: number, r: number) {
  for (let y = 0; y < px.h; y++)
    for (let x = 0; x < px.w; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) px.data[(y * px.w + x) * 4 + 3] = 255;
    }
}
function box(px: { w: number; h: number; data: Uint8ClampedArray }, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.data[(y * px.w + x) * 4 + 3] = 255;
}
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test("scenerylight: a circular silhouette on an ellipse hitbox yields outward normals", () => {
  const px = blank(64, 64);
  disc(px, 32, 36, 24); // rows 12..60, columns 8..56
  const hb: ShapeHitbox = { cx: 32, cy: 58, rx: 24, ry: 10, rect: false, theta: 0 };
  const map = buildShapeMap(px, hb, SC);
  assert.equal(map.w, 64);
  assert.equal(map.opaque, px.data.filter((_, i) => i % 4 === 3 && px.data[i] > 0).length);
  // Alpha is 255 EVERYWHERE — data never rides the alpha channel (Phaser
  // uploads Uint8Array textures premultiplied).
  for (let i = 3; i < map.data.length; i += 4) assert.equal(map.data[i], 255, `alpha at ${i}`);
  // Equator row: left edge faces −x, right edge +x, the middle faces the viewer.
  const eq = 36;
  const L = decodeShape(map, 9, eq);
  const R = decodeShape(map, 54, eq);
  const C = decodeShape(map, 32, eq);
  assert.ok(L.nx < -0.75, `left edge nx ${L.nx}`);
  assert.ok(R.nx > 0.75, `right edge nx ${R.nx}`);
  assert.ok(Math.abs(C.nx) < 0.1, `centre nx ${C.nx}`);
  assert.ok(C.ny > 0.9, `centre ny ${C.ny}`);
  assert.ok(Math.abs(C.nz) < 0.15, `equator nz ${C.nz}`);
  // Monotone across the row: nx never decreases from left to right.
  let prev = -2;
  for (let x = 9; x < 55; x++) {
    const n = decodeShape(map, x, eq);
    assert.ok(n.nx >= prev - 0.01, `nx not monotone at x=${x}: ${prev} -> ${n.nx}`);
    prev = n.nx;
  }
  // The cap faces up, the underside faces down; the depth at the equator's
  // centre is the radius in cells (24 px / (32·√2)).
  assert.ok(decodeShape(map, 32, 14).nz > 0.5, `cap nz ${decodeShape(map, 32, 14).nz}`);
  assert.ok(decodeShape(map, 32, 58).nz < -0.5, `underside nz ${decodeShape(map, 32, 58).nz}`);
  near(C.depth, 24 / (32 * Math.SQRT2), SHAPE_DEPTH_CELLS / 255 + 0.01, "equator depth");
  assert.ok(decodeShape(map, 8, eq).depth < C.depth * 0.5, `edge depth ${decodeShape(map, 8, eq).depth} < half the centre's ${C.depth}`);
  // Smooth: neighbouring OPAQUE texels never jump more than a small step in nx.
  const opaque = (x: number, y: number) => px.data[(y * 64 + x) * 4 + 3] > 0;
  let pairs = 0;
  for (let y = 14; y < 58; y++)
    for (let x = 10; x < 54; x++) {
      if (!opaque(x, y) || !opaque(x + 1, y)) continue;
      const a = decodeShape(map, x, y);
      const b = decodeShape(map, x + 1, y);
      assert.ok(Math.abs(a.nx - b.nx) < 0.2, `nx step at (${x},${y}): ${a.nx} -> ${b.nx}`);
      pairs++;
    }
  assert.ok(pairs > 1500, `smoothness checked over ${pairs} pairs`);
});

test("scenerylight: hflip reads the map in a mirror — N.x negated, texel column mirrored", () => {
  const px = blank(48, 40);
  disc(px, 20, 22, 14); // off-centre on purpose
  box(px, 30, 30, 44, 40);
  const hb: ShapeHitbox = { cx: 22, cy: 36, rx: 14, ry: 6, rect: false, theta: 0 };
  const map = buildShapeMap(px, hb, SC);
  let checked = 0;
  for (let y = 0; y < 40; y++)
    for (let x = 0; x < 48; x++) {
      const f = decodeShape(map, x, y, true);
      const m = decodeShape(map, 47 - x, y, false);
      assert.equal(f.nx, -m.nx, `nx at (${x},${y})`);
      assert.equal(f.ny, m.ny);
      assert.equal(f.nz, m.nz);
      assert.equal(f.depth, m.depth);
      checked++;
    }
  assert.equal(checked, 48 * 40);
  // And the mirror is not the identity: drawn flipped, the disc sits on the
  // RIGHT (columns 14..41) and its screen-right edge — the original left edge,
  // read at column 7 — faces +x, its screen-left edge faces −x.
  assert.ok(decodeShape(map, 7, 22).nx < -0.7, "unflipped left edge faces −x");
  assert.ok(decodeShape(map, 40, 22, true).nx > 0.7, "flipped: the mirrored disc's right edge faces +x");
  assert.ok(decodeShape(map, 14, 22, true).nx < -0.7, "flipped: the mirrored disc's left edge faces −x");
  // The key carries the art, the version, the hitbox and the scale — not the flip.
  const k = shapeMapKey("s3:trees/tree_023/not_lit_3/sprite.webp", hb, SC);
  assert.match(k, /^s3n:trees\/tree_023\/not_lit_3\/sprite\.webp@v\d+:/);
  assert.notEqual(k, shapeMapKey("s3:trees/tree_023/not_lit_3/sprite.webp", { ...hb, rx: 15 }, SC));
  assert.notEqual(k, shapeMapKey("s3:trees/tree_023/not_lit_3/sprite.webp", hb, { ...SC, px2cell: SC.px2cell * 1.1 }));
});

test("scenerylight: a rect hitbox yields box faces — one face south, two turned south-east, a lid on top", () => {
  const px = blank(64, 64);
  box(px, 8, 20, 56, 60); // 48 wide, 40 tall
  const south: ShapeHitbox = { cx: 32, cy: 56, rx: 24, ry: 8, rect: true, theta: rectGroundRot({ rot: 0 }, "south", false) };
  assert.equal(south.theta, 0);
  const ms = buildShapeMap(px, south, SC);
  assert.equal(ms.rect, true);
  for (const x of [12, 24, 32, 40, 52]) {
    const n = decodeShape(ms, x, 46);
    assert.ok(Math.abs(n.nx) < 0.05, `south front face nx at x=${x}: ${n.nx}`);
    assert.ok(n.ny > 0.95, `south front face ny at x=${x}: ${n.ny}`);
    assert.ok(Math.abs(n.nz) < 0.05, `south front face nz at x=${x}: ${n.nz}`);
  }
  // The lid: the top rows face up, rolled in over the footprint's own depth.
  assert.ok(decodeShape(ms, 32, 20).nz > 0.9, `lid nz ${decodeShape(ms, 32, 20).nz}`);
  assert.ok(decodeShape(ms, 32, 28).nz > 0.3 && decodeShape(ms, 32, 28).nz < 0.9, `lid roll nz ${decodeShape(ms, 32, 28).nz}`);
  assert.ok(decodeShape(ms, 32, 40).nz < 0.05, `below the lid nz ${decodeShape(ms, 32, 40).nz}`);
  // Turned south-east (the stamp's own angle: rot − 45°): the box shows its
  // front face (normal toward +x,+y) right of the near corner and its left
  // side face (−x,+y) left of it.
  const se: ShapeHitbox = { ...south, theta: rectGroundRot({ rot: 0 }, "south-east", false) };
  near(se.theta, -Math.PI / 4, 1e-9, "south-east ground turn");
  const mse = buildShapeMap(px, se, SC);
  const l = decodeShape(mse, 14, 46);
  const r = decodeShape(mse, 50, 46);
  assert.ok(l.nx < -0.5 && l.ny > 0.5, `left side face ${JSON.stringify(l)}`);
  assert.ok(r.nx > 0.5 && r.ny > 0.5, `front face ${JSON.stringify(r)}`);
  // …and the roll between them is continuous, never a hard edge.
  let prev = decodeShape(mse, 8, 46).nx;
  for (let x = 9; x < 56; x++) {
    const n = decodeShape(mse, x, 46).nx;
    assert.ok(n >= prev - 0.01 && n - prev < 0.35, `face roll at x=${x}: ${prev} -> ${n}`);
    prev = n;
  }
  // The mirror of a turned box is the box turned the other way: hflip's
  // −45° becomes +45° (rectGroundRot negates on hflip), which the flipped
  // read reproduces without a second map.
  const sw: ShapeHitbox = { ...south, theta: rectGroundRot({ rot: 0 }, "south-east", true) };
  near(sw.theta, Math.PI / 4, 1e-9, "hflip negates the ground turn");
  const msw = buildShapeMap(px, sw, SC);
  const viaMirror = decodeShape(mse, 14, 46, true);
  const direct = decodeShape(msw, 14, 46);
  near(viaMirror.nx, direct.nx, 0.02, "mirrored south-east == south-west nx");
  near(viaMirror.ny, direct.ny, 0.02, "mirrored south-east == south-west ny");
});

test("scenerylight: a crown widens over its trunk — the underside faces down, the top faces up, the trunk faces out", () => {
  const px = blank(64, 64);
  disc(px, 32, 22, 20); // the crown: rows 2..42
  box(px, 28, 40, 36, 64); // the trunk: 8 px wide
  const hb: ShapeHitbox = { cx: 32, cy: 60, rx: 5, ry: 3, rect: false, theta: 0 };
  const prof = alphaRowProfile(px);
  assert.equal(prof.half[50], 4);
  assert.equal(prof.mid[50], 32);
  assert.ok(prof.half[22] >= 19);
  const map = buildShapeMap(px, hb, SC);
  assert.ok(map.maxR > 19 * SC.px2cell, `maxR ${map.maxR}`);
  const under = decodeShape(map, 32, 40);
  const top = decodeShape(map, 32, 4);
  const trunk = decodeShape(map, 32, 54);
  const trunkL = decodeShape(map, 28, 54);
  assert.ok(under.nz < -0.25, `crown underside faces down: ${under.nz}`);
  assert.ok(top.nz > 0.5, `crown top faces up: ${top.nz}`);
  assert.ok(Math.abs(trunk.nz) < 0.15 && trunk.ny > 0.9, `trunk faces the viewer: ${JSON.stringify(trunk)}`);
  assert.ok(trunkL.nx < -0.6, `trunk's left edge faces −x: ${trunkL.nx}`);
  assert.ok(decodeShape(map, 13, 22).nx < -0.8, "crown's left edge faces −x");
  // Depth: the crown's centre stands its radius nearer the viewer than the trunk's.
  assert.ok(decodeShape(map, 32, 22).depth > trunk.depth + 0.2, `crown depth ${decodeShape(map, 32, 22).depth} vs trunk ${trunk.depth}`);
});

test("scenerylight: the per-light term is the ground's attenuation (z weighted SHAPE_ZW_ATT) with a wrapped Lambert from the axis; glow pools have no direction", () => {
  const N = { nx: -1, ny: 0, nz: 0 }; // a texel facing −x
  const P = { x: 0, y: 0, z: 0 };
  const leftLight = { x: -2, y: 0, z: 0, radius: 6 };
  const rightLight = { x: 2, y: 0, z: 0, radius: 6 };
  const a = shapeLightTerm(N, P, leftLight, 0.5);
  const b = shapeLightTerm(N, P, rightLight, 0.5);
  near(a.att, (1 - 2 / 6) ** 2, 1e-9, "attenuation = (1 − d/r)²");
  assert.equal(a.lam, 1, "lit from its own side");
  assert.equal(b.lam, 0, "dark from behind (wrap 0.5 → dot −1 maps to 0)");
  assert.equal(shapeLightTerm(N, P, { ...rightLight, radius: -6 }, 0.5).lam, 1, "a glow pool lights every side");
  near(shapeLightTerm({ nx: 0, ny: 1, nz: 0 }, P, rightLight, 0.5).lam, 0.5, 1e-9, "grazing = the wrap floor");
  // The Lambert direction is the AXIS's horizontal direction to the light, so
  // a texel out on the crown's near side is lit exactly like one at the axis
  // (no per-texel flip when the torch stands under the crown) — only its
  // attenuation differs, by the texel's own distance.
  const edge = shapeLightTerm(N, { x: -1.4, y: 0.3, z: 8 }, leftLight, 0.5);
  assert.equal(edge.lam, 1, "same direction as the axis");
  near(edge.att, (1 - Math.hypot(-0.6, -0.3, -8 * SHAPE_ZW_ATT) / 6) ** 2, 1e-9, "attenuation from the texel's own position");
  // A torch held AT the axis: the direction floors at SHAPE_AXIS_MIN, every
  // side reads the wrap level instead of flipping on a sub-cell offset.
  near(shapeLightTerm(N, P, { x: 0.01, y: 0, z: 0.55, radius: 6 }, 0.5).lam, 0.5 - 0.5 * (0.01 / SHAPE_AXIS_MIN), 1e-9, "axis floor");
  // The vertical weight: a light 5 levels up at the foot attenuates like a
  // light 5·SHAPE_ZW_ATT cells away on the ground.
  near(shapeLightTerm(N, P, { x: 0, y: 0, z: 5, radius: 6 }, 0.5).att, (1 - (5 * SHAPE_ZW_ATT) / 6) ** 2, 1e-9, "z weighted SHAPE_ZW_ATT");
  assert.equal(shapeLightTerm(N, P, { x: 7, y: 0, z: 0, radius: 6 }, 0.5).att, 0, "beyond the radius");
});

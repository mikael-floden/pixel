// The ambient deep-water effect draws the REAL deep-sea current: the same
// vector the server integrates and the client predicts. Its whole claim is that
// the drift streams the way the swimmer is actually being pushed, at the rate
// they are being pushed — so the two things that turn that vector into a
// picture have to be right, and neither is visible in a screenshot.
//
//   1. THE PROJECTION. `deepCurrentAt` answers in FLAT world space; everything
//      drawn lives on the iso plane. Flat "south" and drawn "south" are
//      different directions on screen, so an unprojected vector would stream
//      the drift visibly askew from the drag — and plausibly enough to ship.
//   2. THE RAMP. Strength must be 0 in the free shallows and reach 1 out at
//      sea, because it scales count, brightness and length; an inverted or
//      clipped ramp would make the current loudest exactly where it does not
//      act.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CELL_WU,
  DEEP_CURRENT_FREE_CELLS,
  DEEP_CURRENT_MAX,
  DEEP_CURRENT_RAMP_CELLS,
  ISO_DX,
  ISO_DY,
} from "@nangijala/shared";
import { ANGLE_STEPS, angleIndex, angleOf, drawnFlow, flatToDrawn, rasterLine } from "../../ambient/deepwater/current.js";

test("the projection matches the world's own iso formula, not an approximation", () => {
  // x = (col - row) * ISO_DX, y = (col + row) * ISO_DY. Check it against the
  // definition at a few deltas rather than against a copied constant.
  for (const [dx, dy] of [[32, 0], [0, 32], [32, 32], [-64, 16], [7, -3]]) {
    const got = flatToDrawn(dx, dy);
    const col = dx / CELL_WU;
    const row = dy / CELL_WU;
    assert.ok(Math.abs(got.x - (col - row) * ISO_DX) < 1e-9, `x for ${dx},${dy}`);
    assert.ok(Math.abs(got.y - (col + row) * ISO_DY) < 1e-9, `y for ${dx},${dy}`);
  }
});

test("the projection is ANISOTROPIC — the drawn drag is not the flat drag", () => {
  // This is the bug the projection exists to prevent: along one tile axis the
  // same current covers far more drawn ground than along the other. If these
  // ever come out equal, someone has replaced the projection with a scale.
  const alongX = drawnFlow({ dx: 1, dy: -1, speed: DEEP_CURRENT_MAX })!; // one tile axis
  const alongY = drawnFlow({ dx: 1, dy: 1, speed: DEEP_CURRENT_MAX })!; // the other
  assert.ok(alongX.speed > alongY.speed * 1.5,
    `expected a strong anisotropy, got ${alongX.speed} vs ${alongY.speed}`);
  // And a flat cardinal must NOT stay a drawn cardinal (that is the askew bug).
  const flatSouth = drawnFlow({ dx: 0, dy: 1, speed: DEEP_CURRENT_MAX })!;
  assert.ok(Math.abs(flatSouth.ux) > 0.5,
    `flat south should lean hard on screen x, got ux=${flatSouth.ux}`);
});

test("drawn speed IS the flat speed carried through the projection", () => {
  // The honesty property: doubling the current doubles what the eye sees.
  const half = drawnFlow({ dx: 1, dy: 0, speed: DEEP_CURRENT_MAX / 2 })!;
  const full = drawnFlow({ dx: 1, dy: 0, speed: DEEP_CURRENT_MAX })!;
  assert.ok(Math.abs(full.speed / half.speed - 2) < 1e-9);
  assert.ok(Math.abs(Math.hypot(full.ux, full.uy) - 1) < 1e-12, "direction must be unit");
});

test("strength is 0 in the free shallows and 1 out at sea, matching the game's ramp", () => {
  // Re-derive the shipped ramp from the shared constants and check the ends.
  const speedAtDepth = (d: number) => {
    const t = (d - DEEP_CURRENT_FREE_CELLS) / (DEEP_CURRENT_RAMP_CELLS - DEEP_CURRENT_FREE_CELLS);
    return t > 0 ? Math.min(1, t) * DEEP_CURRENT_MAX : 0;
  };
  assert.equal(drawnFlow({ dx: 1, dy: 0, speed: speedAtDepth(DEEP_CURRENT_FREE_CELLS) }), null,
    "the shoreline band must stay free of the effect");
  const mid = drawnFlow({ dx: 1, dy: 0, speed: speedAtDepth(4) })!;
  assert.ok(mid.strength > 0.1 && mid.strength < 0.9, `mid-ramp should be partial, got ${mid.strength}`);
  const sea = drawnFlow({ dx: 1, dy: 0, speed: speedAtDepth(DEEP_CURRENT_RAMP_CELLS + 50) })!;
  assert.equal(sea.strength, 1, "open sea is full strength");
});

test("no current, a degenerate vector and a missing reading all draw nothing", () => {
  assert.equal(drawnFlow(null), null);
  assert.equal(drawnFlow({ dx: 1, dy: 0, speed: 0 }), null);
  assert.equal(drawnFlow({ dx: 0, dy: 0, speed: DEEP_CURRENT_MAX }), null, "map centre must not divide by zero");
});

test("the crest lies across the flow IN THE WORLD, not on screen", () => {
  // The iso projection is not conformal — a world right angle is NOT a right
  // angle on screen (that is why a square tile draws as a rhombus). So this
  // derives the expectation from the world turn instead of eyeballing the drawn
  // dot product, which is ~47 degrees off along the tile axes and looks wrong
  // until you work it out. Turning the DRAWN vector instead would stand every
  // crest off the water plane.
  const S = Math.SQRT1_2;
  const flats: [number, number][] = [
    [1, 0], [S, S], [0, 1], [-S, S], [-1, 0], [-S, -S], [0, -1], [S, -S],
  ];
  let screenPerp = 0;
  for (const [fx, fy] of flats) {
    const f = drawnFlow({ dx: fx, dy: fy, speed: 60 })!;
    const want = flatToDrawn(-fy, fx);
    const L = Math.hypot(want.x, want.y);
    assert.ok(
      Math.abs(f.cx - want.x / L) < 1e-9 && Math.abs(f.cy - want.y / L) < 1e-9,
      `crest at flat (${fx}, ${fy}) is not the projected world quarter turn`,
    );
    if (Math.abs(f.ux * f.cx + f.uy * f.cy) < 1e-9) screenPerp++;
  }
  /* Non-vacuity, and the measurement that says which turn shipped. If the crest
   * were a SCREEN quarter turn, all eight would read exactly perpendicular on
   * screen. Exactly FOUR do, and it is always the same four: a flat DIAGONAL
   * projects onto a screen axis (a flat (S,S) draws straight down the screen),
   * and there the world turn and the screen turn coincide. The four flat
   * CARDINALS are the tile axes, and there the crest's drawn dot against its
   * own travel is +-0.6787 — the ~47 degrees the projection makes of a right
   * angle, measured, not chosen. */
  assert.equal(screenPerp, 4, `${screenPerp} of ${flats.length} crests are screen-perpendicular — expected the 4 flat diagonals`);
  for (const [fx, fy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as [number, number][]) {
    const f = drawnFlow({ dx: fx, dy: fy, speed: 60 })!;
    assert.ok(
      Math.abs(Math.abs(f.ux * f.cx + f.uy * f.cy) - 0.6787) < 0.001,
      `a tile-axis crest should sit at the projection's own ~47 degrees, got ${(f.ux * f.cx + f.uy * f.cy).toFixed(4)}`,
    );
  }
});

test("art rasterises at ANY angle, as whole pixels, with none drawn twice", () => {
  // Free rotation is the maintainer's ask (2026-09-07); what may never happen
  // is RESAMPLING, so every angle has to come out as integer pixels on the
  // world's own grid rather than as a rotated sprite.
  for (let i = 0; i < ANGLE_STEPS; i++) {
    const r = rasterLine(i, 9);
    assert.ok(r.px.length >= 4, `angle ${i} produced only ${r.px.length} pixels`);
    for (const [x, y] of r.px) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `non-integer pixel at angle ${i}`);
      assert.ok(x >= 0 && y >= 0 && x < r.w && y < r.h, `pixel outside the bitmap at angle ${i}`);
    }
    // A doubled pixel would paint the same additive spot twice and read as a
    // bright dot on the crest.
    const seen = new Set(r.px.map(([x, y]) => `${x},${y}`));
    assert.equal(seen.size, r.px.length, `angle ${i} has duplicate pixels`);
  }
  // The ring really is fine-grained, and really does turn: 64 distinct shapes'
  // worth of angles, and a line drawn at one of them lands within half a step
  // of the direction asked for.
  assert.ok(ANGLE_STEPS >= 32, `${ANGLE_STEPS} angles is coarse enough to read as a family of tick marks`);
  const half = Math.PI / ANGLE_STEPS;
  for (const deg of [0, 7, 23, 41, 88, 179, 271, 359]) {
    const a = (deg * Math.PI) / 180;
    const i = angleIndex(Math.cos(a), Math.sin(a));
    const err = Math.abs(Math.atan2(Math.sin(angleOf(i) - a), Math.cos(angleOf(i) - a)));
    assert.ok(err <= half + 1e-9, `${deg} deg snapped ${((err * 180) / Math.PI).toFixed(2)} deg away`);
  }
  // A shallow angle must STAGGER rather than come out as a straight diagonal —
  // that stagger is what makes a crest look like it lies on the water.
  const shallow = rasterLine(2, 21); // ~11 degrees
  assert.ok(shallow.w > shallow.h && shallow.h > 1, `a shallow line should stagger, got ${shallow.w}x${shallow.h}`);
});

// THE CURRENT STEERS TO THE NEAREST MAIN LAND, NOT THE MAP CENTRE (maintainer,
// 2026-09-07). The centre was the first cut and it is wrong the moment the
// coast is not a circle: swum out from a western bay you were dragged EAST
// along the shore instead of back onto the beach a few cells behind you.
// These run against the shipped world, so they also guard the land data.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorld,
  buildTerrainGrid,
  deepCurrentAt,
  surfaceFor,
  MAIN_LAND_MIN_CELLS,
  COAST_CURRENT_FREE_CELLS,
  COAST_CURRENT_MAX,
  RUN_SPEED,
} from "@nangijala/shared";

const here3 = dirname(fileURLToPath(import.meta.url));
const GAME = join(here3, "..", "..", "..", "maps2", "worlds3", "the_game", "world.json");
const doc3 = existsSync(GAME) ? JSON.parse(readFileSync(GAME, "utf8")) : null;
const world3 = doc3 ? parseWorld(doc3) : null;
const grid3 = world3 ? buildTerrainGrid(world3.width, world3.height, world3.rows, world3.props, world3.decks) : null;

/** Every deep-water cell that carries a current, as grid indices. */
function deepCells(g: NonNullable<typeof grid3>): number[] {
  const out: number[] = [];
  for (let i = 0; i < g.type.length; i++) if (g.type[i] === "deep_water") out.push(i);
  return out;
}

/** Distance in cells from a world point to the nearest standable cell. */
function landDist(g: NonNullable<typeof grid3>, x: number, y: number): number {
  const c = x / CELL_WU;
  const r = y / CELL_WU;
  let best = Infinity;
  for (let rr = 0; rr < g.height; rr++)
    for (let cc = 0; cc < g.width; cc++) {
      if (!surfaceFor(g.type[rr * g.width + cc]).standable) continue;
      const d = (cc + 0.5 - c) * (cc + 0.5 - c) + (rr + 0.5 - r) * (rr + 0.5 - r);
      if (d < best) best = d;
    }
  return Math.sqrt(best);
}

test("following the drag carries you toward land and then releases you", () => {
  if (!grid3) return test.skip("maps2/worlds3/the_game missing");
  const g = grid3;
  const cells = deepCells(g);
  assert.ok(cells.length > 500, `the world must have open sea to test (${cells.length})`);
  let tested = 0;
  let released = 0;
  let closer = 0;
  for (let k = 0; k < cells.length; k += Math.max(1, Math.floor(cells.length / 40))) {
    const i = cells[k];
    const c = i % g.width;
    const r = (i - c) / g.width;
    let x = (c + 0.5) * CELL_WU;
    let y = (r + 0.5) * CELL_WU;
    if (!deepCurrentAt(g, x, y)) continue; // already in the current-free band
    tested++;
    const before = landDist(g, x, y);
    let steps = 0;
    for (; steps < 4000; steps++) {
      const cur = deepCurrentAt(g, x, y);
      if (!cur) break; // the current has let go: shore, or the free band at it
      x += cur.dx * CELL_WU * 0.5;
      y += cur.dy * CELL_WU * 0.5;
      if (x < 0 || y < 0 || x >= g.width * CELL_WU || y >= g.height * CELL_WU) break;
    }
    if (steps < 4000) released++;
    if (landDist(g, x, y) < before - 0.5) closer++;
  }
  assert.ok(tested > 15, `too few sampled cells carried a current (${tested})`);
  assert.equal(released, tested, `${tested - released} swimmers were still being dragged after 4000 steps`);
  assert.equal(closer, tested, `${tested - closer} swimmers did not end up closer to land than they started`);
});

// THE DRAG MUST NOT ABANDON YOU AT SEA. It used to be gated on `deep_water`,
// so it let go the instant you crossed into the shallow belt — measured over
// the whole open sea, 1,510 of 1,531 swimmers were dropped still in deep water,
// a MEDIAN 22.6 CELLS FROM LAND, because the island wears a belt of `water` up
// to 22.8 cells wide (maintainer 2026-09-07: "now the deep_water brings you
// back to closest water. I said closest main land. Not closest water"). The
// old test above only asked that you end up CLOSER than you started, which
// 22.6 cells out satisfies — this one asks that you end up THERE.
test("the drag releases you at the shore, not 20 cells out at sea", () => {
  if (!grid3) return test.skip("maps2/worlds3/the_game missing");
  const g = grid3;
  const cells = deepCells(g);
  const ends: number[] = [];
  for (let k = 0; k < cells.length; k += Math.max(1, Math.floor(cells.length / 40))) {
    const i = cells[k];
    const c = i % g.width;
    const r = (i - c) / g.width;
    let x = (c + 0.5) * CELL_WU;
    let y = (r + 0.5) * CELL_WU;
    if (!deepCurrentAt(g, x, y)) continue;
    for (let steps = 0; steps < 4000; steps++) {
      const cur = deepCurrentAt(g, x, y);
      if (!cur) break;
      x += cur.dx * CELL_WU * 0.5;
      y += cur.dy * CELL_WU * 0.5;
      if (x < 0 || y < 0 || x >= g.width * CELL_WU || y >= g.height * CELL_WU) break;
    }
    ends.push(landDist(g, x, y));
  }
  assert.ok(ends.length > 15, `too few sampled swimmers (${ends.length})`);
  // The free band is what you are left to swim yourself, plus at most one step
  // of overshoot. Anything beyond that is the old bug back.
  const cap = COAST_CURRENT_FREE_CELLS + 2;
  const far = ends.filter((d) => d > cap);
  assert.equal(
    far.length,
    0,
    `${far.length} swimmers were dropped further than ${cap} cells from land (worst ${Math.max(...ends).toFixed(1)})`,
  );
});

test("the coastal pull is out-swimmable, and the deep one is not", () => {
  // The two halves of the current exist for opposite reasons: the deep one is
  // the edge of the world and must beat the strongest stroke, the coastal one
  // carries you the rest of the way in and must NOT — or the shallow belt
  // becomes a wall, the islands become unreachable, and you can never leave a
  // beach. RUN_SPEED * deep_water.speed is the fastest a body swims.
  const swim = RUN_SPEED * surfaceFor("deep_water").speed;
  assert.ok(COAST_CURRENT_MAX < swim, `coastal pull ${COAST_CURRENT_MAX} must be beatable by a ${swim} wu/s swim`);
  assert.ok(DEEP_CURRENT_MAX > swim, `deep pull ${DEEP_CURRENT_MAX} must beat a ${swim} wu/s swim`);
});

test("it aims at the NEAREST main land — and that is NOT the map centre", () => {
  if (!grid3) return test.skip("maps2/worlds3/the_game missing");
  const g = grid3;
  const cx = (g.width * CELL_WU) / 2;
  const cy = (g.height * CELL_WU) / 2;
  const cells = deepCells(g);
  let checked = 0;
  let disagreements = 0;
  // Spread the samples across the whole sea; the first cells in index order are
  // all along one edge, where land and the centre happen to agree.
  for (let k = 0; k < cells.length && checked < 14; k += Math.max(1, Math.floor(cells.length / 90))) {
    const i = cells[k];
    const c = i % g.width;
    const r = (i - c) / g.width;
    const x = (c + 0.5) * CELL_WU;
    const y = (r + 0.5) * CELL_WU;
    const cur = deepCurrentAt(g, x, y);
    if (!cur) continue;
    checked++;
    // The nearest standable cell, found independently of the implementation.
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let rr = 0; rr < g.height; rr++)
      for (let cc = 0; cc < g.width; cc++) {
        if (!surfaceFor(g.type[rr * g.width + cc]).standable) continue;
        const d = (cc - c) * (cc - c) + (rr - r) * (rr - r);
        if (d < best) { best = d; bx = cc; by = rr; }
      }
    const lx = (bx + 0.5) * CELL_WU - x;
    const ly = (by + 0.5) * CELL_WU - y;
    const ll = Math.hypot(lx, ly) || 1;
    assert.ok(
      cur.dx * (lx / ll) + cur.dy * (ly / ll) > 0.8,
      `at ${c},${r} the drag ${cur.dx.toFixed(2)},${cur.dy.toFixed(2)} does not point at the nearest land ${bx},${by}`,
    );
    const mx = cx - x;
    const my = cy - y;
    const ml = Math.hypot(mx, my) || 1;
    if (cur.dx * (mx / ml) + cur.dy * (my / ml) < 0.9) disagreements++;
  }
  assert.ok(checked > 8, `too few deep cells sampled (${checked})`);
  assert.ok(
    disagreements > 0,
    "land and the map centre agreed at every sample — this test would not have caught the old behaviour",
  );
});

test("a speck of land is not a destination", () => {
  assert.ok(MAIN_LAND_MIN_CELLS >= 20, "the_game's smallest land mass is an 18-cell rock; it must not be a target");
  assert.ok(MAIN_LAND_MIN_CELLS <= 180, "its real islands are 184 cells and up; they must stay targets");
});

// The ambient deep-water effect draws the REAL deep-sea current: the same
// vector the server integrates and the client predicts. Its whole claim is that
// the foam streams the way the swimmer is actually being pushed, at the rate
// they are being pushed — so the two things that turn that vector into a
// picture have to be right, and neither is visible in a screenshot.
//
//   1. THE PROJECTION. `deepCurrentAt` answers in FLAT world space; everything
//      drawn lives on the iso plane. Flat "south" and drawn "south" are
//      different directions on screen, so an unprojected vector would stream
//      the foam visibly askew from the drag — and plausibly enough to ship.
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
import { crossDir8, dir8, drawnFlow, flatToDrawn, FLOW_DIRS, rasterLine } from "../../ambient/deepwater/current.js";

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

test("dir8 picks each of the 8 drawn directions, and the crest lies across the flow", () => {
  for (let i = 0; i < FLOW_DIRS.length; i++) {
    assert.equal(dir8(FLOW_DIRS[i][0], FLOW_DIRS[i][1]), i, `direction ${i} should resolve to itself`);
  }
  // A crest lies across its travel IN THE WORLD, and the iso projection is not
  // conformal — a world right angle is NOT a right angle on screen (that is why
  // a square tile draws as a rhombus). So this asserts the world-space turn and
  // derives the expectation instead of eyeballing the drawn dot product, which
  // is ~47 degrees off for the tile axes and looks wrong until you work it out.
  const S = Math.SQRT1_2;
  const flats: [number, number][] = [
    [1, 0], [S, S], [0, 1], [-S, S], [-1, 0], [-S, -S], [0, -1], [S, -S],
  ];
  const idxOf = (fx: number, fy: number) => {
    const d = flatToDrawn(fx, fy);
    const L = Math.hypot(d.x, d.y);
    return dir8(d.x / L, d.y / L);
  };
  for (const [fx, fy] of flats) {
    assert.equal(idxOf(-fy, fx), crossDir8(idxOf(fx, fy)),
      `crossDir8 is not a world-space quarter turn at flat (${fx}, ${fy})`);
  }
});

test("streaks rasterise as whole pixels on the grid the world is drawn on", () => {
  for (let i = 0; i < 8; i++) {
    const r = rasterLine(i, 9);
    assert.ok(r.px.length >= 4, `direction ${i} produced only ${r.px.length} pixels`);
    for (const [x, y] of r.px) {
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `non-integer pixel in direction ${i}`);
      assert.ok(x >= 0 && y >= 0 && x < r.w && y < r.h, `pixel outside the bitmap in direction ${i}`);
    }
    // No duplicate cells — the iso stagger repeats a step and a doubled pixel
    // would paint the same additive spot twice and read as a bright dot.
    const seen = new Set(r.px.map(([x, y]) => `${x},${y}`));
    assert.equal(seen.size, r.px.length, `direction ${i} has duplicate pixels`);
  }
  // The two tile-axis directions must actually STAGGER (32:14), not come out
  // as a straight diagonal — that stagger is what makes them look like terrain.
  const diag = rasterLine(1, 9);
  assert.ok(diag.w > diag.h && diag.h > 1, `tile-axis streak should be shallow, got ${diag.w}x${diag.h}`);
});

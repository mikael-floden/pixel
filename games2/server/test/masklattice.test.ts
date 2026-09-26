// THE MIST MASK'S LATTICE — the rect and step ambient's mount rasterises the
// zone field's mist over each env tick (ambient/runtime/masklattice.ts).
//
// What a screenshot cannot pin: that a camera zooming with the run keeps ONE
// lattice (a new step is a whole 2,560-sample raster in one tick), that the
// kept lattice still holds the view with room for a tick of travel, and that
// the resting lattice is the one it always was.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MASK_COLS, MASK_MARGIN, MASK_ROWS, MASK_STEP_GROW, MASK_STEP_Q, MASK_STEP_SLACK, MASK_TRAVEL,
  latticeStep, maskRect, type MaskLattice,
} from "../../ambient/runtime/masklattice.js";

/** WorldScene's chase cam: CAM_ZOOM_OUT of the zoom shed at a run, eased in
 *  0.45 s out and 0.85 s back (updateChaseCam). */
const CAM_ZOOM_OUT = 0.32;
const view = (cx: number, cy: number, w: number, h: number) => ({ x: cx - w / 2, y: cy - h / 2, width: w, height: h });
/** His screen at rest (393x851 @2.75, zoom 3) and turned on its side. */
const PORTRAIT = { w: 360, h: 495 };
const LANDSCAPE = { w: 780, h: 300 };

/** The rule before 2026-09-26, for the "at rest it is what it was" arms. */
const before = (have: number, need: number) =>
  have >= need && have <= need * MASK_STEP_SLACK ? have : Math.ceil((need * MASK_STEP_GROW) / MASK_STEP_Q) * MASK_STEP_Q;

/** Run-and-stop cycles through the chase cam's zoom, one env tick every
 *  105 ms, the camera travelling at a run: every rect the mount would ask for. */
function runStop(screen: { w: number; h: number }, cycles: number, lat: MaskLattice) {
  const out: { rect: ReturnType<typeof maskRect>; v: ReturnType<typeof view>; step: string }[] = [];
  let k = 0, cx = 5000, cy = 5000;
  const dt = 0.105;
  const tick = (moving: boolean) => {
    const z = 1 - CAM_ZOOM_OUT * k;
    if (moving) { cx += 175 * dt; cy += 60 * dt; }
    const v = view(cx, cy, screen.w / z, screen.h / z);
    const rect = maskRect(v, lat);
    out.push({ rect, v, step: `${lat.stepX}x${lat.stepY}` });
  };
  for (let c = 0; c < cycles; c++) {
    for (let t = 0; t < 3; t += dt) { k += (1 - k) * (1 - Math.exp(-dt / 0.45)); tick(true); }
    for (let t = 0; t < 1.5; t += dt) { k += (0 - k) * (1 - Math.exp(-dt / 0.85)); tick(false); }
  }
  return out;
}

test("at rest the lattice is the one it always was: the padded view over the columns, with headroom, in whole units", () => {
  for (const s of [PORTRAIT, LANDSCAPE]) {
    const lat = { stepX: 0, stepY: 0 };
    const v = view(1000, 1000, s.w, s.h);
    const r = maskRect(v, lat);
    const needX = (s.w * (1 + 2 * MASK_MARGIN)) / MASK_COLS, needY = (s.h * (1 + 2 * MASK_MARGIN)) / MASK_ROWS;
    assert.equal(lat.stepX, before(0, needX));
    assert.equal(lat.stepY, before(0, needY));
    // his screen: 10 x 22 world px, the rect centred on the view up to the snap
    if (s === PORTRAIT) assert.deepEqual([lat.stepX, lat.stepY], [10, 22]);
    assert.equal(r.width, lat.stepX * MASK_COLS);
    assert.equal(r.x % lat.stepX, 0, "anchored to the world in whole steps");
    assert.equal(r.y % lat.stepY, 0);
    assert.ok(r.x <= v.x && r.x + r.width >= v.x + v.width && r.y <= v.y && r.y + r.height >= v.y + v.height);
  }
});

test("running and stopping keeps ONE lattice — the zoom breathing with speed never asks for a new raster", () => {
  for (const s of [PORTRAIT, LANDSCAPE]) {
    const ticks = runStop(s, 20, { stepX: 0, stepY: 0 });
    const steps = new Set(ticks.map((t) => t.step));
    assert.equal(steps.size, 1, `one step through 20 run-and-stop cycles on ${s.w}x${s.h}, got ${[...steps].join(", ")}`);
    // the rule it replaces asked for a new one several times a cycle
    let changes = 0, sx = 0, sy = 0;
    for (const t of ticks) {
      const nx = before(sx, (t.v.width * 1.5) / MASK_COLS), ny = before(sy, (t.v.height * 1.5) / MASK_ROWS);
      if (sx && (nx !== sx || ny !== sy)) changes++;
      sx = nx; sy = ny;
    }
    assert.ok(changes >= 40, `the old rule re-latticed ${changes} times in 20 cycles`);
  }
});

test("the kept lattice holds the whole view with a step of snap and a tick of travel on every side", () => {
  for (const s of [PORTRAIT, LANDSCAPE]) {
    for (const { rect, v } of runStop(s, 5, { stepX: 0, stepY: 0 })) {
      assert.ok(v.x - rect.x >= MASK_TRAVEL, `left ${v.x - rect.x}`);
      assert.ok(rect.x + rect.width - (v.x + v.width) >= MASK_TRAVEL, `right ${rect.x + rect.width - (v.x + v.width)}`);
      assert.ok(v.y - rect.y >= MASK_TRAVEL, `top ${v.y - rect.y}`);
      assert.ok(rect.y + rect.height - (v.y + v.height) >= MASK_TRAVEL, `bottom ${rect.y + rect.height - (v.y + v.height)}`);
    }
  }
});

test("a view that really changed takes a new lattice: rotated, grown past the lattice, shrunk far below it", () => {
  const lat = { stepX: 0, stepY: 0 };
  maskRect(view(0, 0, PORTRAIT.w, PORTRAIT.h), lat);
  const rest = { ...lat };
  maskRect(view(0, 0, LANDSCAPE.w, LANDSCAPE.h), lat);
  assert.notEqual(lat.stepX, rest.stepX, "turned on its side: the columns are asked for a wider view");
  assert.notEqual(lat.stepY, rest.stepY);
  // a view the lattice cannot hold with the travel: a new, coarser step
  const l2 = { stepX: 10, stepY: 22 };
  maskRect(view(0, 0, 700, 900), l2);
  assert.ok(l2.stepX > 10 && l2.stepY > 22);
  // a view so small the kept step would be SLACK times coarser than it needs: a finer one
  const l3 = { stepX: 10, stepY: 22 };
  maskRect(view(0, 0, 200, 250), l3);
  assert.ok(l3.stepX < 10 && l3.stepY < 22);
});

test("latticeStep keeps a step only while it holds the view and is not SLACK times coarser than needed; else the new-lattice step", () => {
  for (const n of [MASK_COLS, MASK_ROWS])
    for (let viewPx = 120; viewPx <= 2000; viewPx += 7)
      for (let have = 0; have <= 80; have += 2) {
        const s = latticeStep(have, viewPx, n);
        const need = (viewPx * (1 + 2 * MASK_MARGIN)) / n;
        const fresh = Math.ceil((need * MASK_STEP_GROW) / MASK_STEP_Q) * MASK_STEP_Q;
        const holds = have > 0 && have * n >= viewPx + 2 * (have + MASK_TRAVEL) && have <= need * MASK_STEP_SLACK;
        assert.equal(s, holds ? have : fresh, `${have} for a ${viewPx} px view over ${n}: ${holds ? "kept" : "a new lattice's step"}`);
        assert.equal(s % MASK_STEP_Q, 0, "whole units of Q");
      }
});

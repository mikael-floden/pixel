import test from "node:test";
import assert from "node:assert/strict";
import { cameraZoom, zoomStep, CAM_ZOOM_LAND_RATE } from "../../client/src/camzoom";

// The isometric projection's steps, from client/src/tiles3.ts. Every one of
// these has to land on a whole BACKING pixel or neighbouring rows snap in
// opposite directions under roundPixels and a 1px seam opens between them.
const STEPS = [32, 14, 15]; // DX, DY, storey pitch
// Real devicePixelRatios: desktop, retina, and the Android fractions that
// broke it (2.625 = 420dpi, 2.75 = 440dpi).
const DPRS = [1, 1.5, 2, 2.25, 2.5, 2.625, 2.75, 3, 3.5, 4];
const WIDTHS = [360, 390, 412, 768, 1080, 1170, 1284, 1440, 1920, 2560, 3840];

test("the camera rests at a WHOLE number of backing pixels per world pixel", () => {
  for (const rs of DPRS)
    for (const cssW of WIDTHS) {
      const backing = Math.round(cssW * rs);
      const z = cameraZoom(backing, rs);
      assert.ok(Number.isInteger(z), `zoom ${z} at dpr ${rs}, css ${cssW}`);
      assert.ok(z >= 1, `zoom ${z} must be at least 1`);
      for (const step of STEPS)
        assert.ok(
          Number.isInteger(step * z),
          `a ${step}px projection step lands on ${step * z} backing px at dpr ${rs}`,
        );
    }
});

test("the OLD formula really did land on half pixels (this gate is not vacuous)", () => {
  const old = (backing: number, rs: number) => Math.max(1, Math.round(backing / (520 * rs))) * rs;
  // 440dpi Android: css 393 x 2.75 = 1080 backing, and DY=14 lands on 38.5
  const rs = 2.75;
  const backing = Math.round(393 * rs);
  const before = old(backing, rs);
  assert.equal(before, 2.75, "the old zoom was the raw fraction");
  assert.equal(14 * before, 38.5, "half a backing pixel per iso row — the seam");
  assert.ok(!Number.isInteger(14 * before));
  // and the new one is whole
  assert.ok(Number.isInteger(14 * cameraZoom(backing, rs)));
});

test("rs=1 is byte-identical to the old behaviour — the desktop kill switch", () => {
  const old = (backing: number, rs: number) => Math.max(1, Math.round(backing / (520 * rs))) * rs;
  for (const cssW of WIDTHS) assert.equal(cameraZoom(cssW, 1), old(cssW, 1), `css ${cssW}`);
});

// --- THE EASE HAS TO ARRIVE, or the ground crawls under a standing player.
// The shimmer, computed rather than photographed: with the camera centre fixed,
// a ground texel at world offset r lands on backing pixel round(r * z), so a
// change in z moves some texels and not others. It reads as SHIMMER (not as a
// zoom) exactly when texels jump while z is moving too slowly to be seen —
// under 0.05 zoom per second, measured. His report, 2026-09-18: "the player
// stops and the camera slowly zooms in... the floor shimmer under it".
const HALF = 420;   // world px from the screen centre to its edge
const texelsJumped = (a: number, b: number) => {
  let n = 0;
  for (let r = 0; r <= HALF; r++) if (Math.round(r * a) !== Math.round(r * b)) n++;
  return n;
};
/** Run the stop-ease frame by frame and report what it looked like. */
function stopEase(step: (cur: number, target: number, dt: number, tau: number) => number) {
  const BASE = 3, OUT = 0.32, TAU_IN = 0.85, DT = 1 / 60;
  let z = BASE * (1 - OUT), t = 0, crawl = 0, land = -1, peak = 0;
  for (let i = 0; i < 60 * 12; i++) {
    const prev = z;
    t += DT;
    z = step(prev, BASE, DT, TAU_IN);
    const rate = Math.abs(z - prev) / DT;
    peak = Math.max(peak, rate);
    if (texelsJumped(prev, z) > 0 && rate < 0.05) crawl++;
    if (z === BASE && land < 0) land = t;
  }
  return { crawl, land, peak };
}

test("the zoom ease LANDS on its target, and never crawls sub-pixel while it does", () => {
  const now = stopEase(zoomStep);
  assert.equal(now.crawl, 0, `no frame may move texels without reading as a zoom (got ${now.crawl})`);
  assert.ok(now.land > 0 && now.land < 3, `lands exactly, in bounded time (${now.land.toFixed(2)} s)`);
  // ...and it does NOT speed up the curve he tuned: the floor only acts where
  // the ease itself has gone slower than CAM_ZOOM_LAND_RATE.
  assert.ok(now.peak < 1.2, `peak rate ${now.peak.toFixed(3)}/s stays the eased one`);
  assert.equal(CAM_ZOOM_LAND_RATE, 0.1, "the tail's floor is 0.1 zoom/s");
});

test("...and the old exponential-with-a-tiny-snap really did crawl (this gate is not vacuous)", () => {
  const before = stopEase((cur, target, dt, tau) => {
    const z = cur + (target - cur) * (1 - Math.exp(-dt / tau));
    return Math.abs(z - target) < 0.0015 ? target : z;
  });
  assert.ok(before.crawl > 100, `the old ease crawled for ${before.crawl} frames`);
  assert.ok(before.land > 5, `and only landed after ${before.land.toFixed(2)} s`);
});

test("zoomStep is monotone, never overshoots, and holds a target it has reached", () => {
  for (const [from, to] of [[2.04, 3], [3, 2.04], [1, 1], [2.9999, 3]]) {
    let z = from;
    for (let i = 0; i < 60 * 12; i++) {
      const next = zoomStep(z, to, 1 / 60, 0.85);
      if (to >= from) assert.ok(next >= z - 1e-12 && next <= to + 1e-12, `${z} -> ${next} toward ${to}`);
      else assert.ok(next <= z + 1e-12 && next >= to - 1e-12, `${z} -> ${next} toward ${to}`);
      z = next;
    }
    assert.equal(z, to, `${from} -> ${to} arrives and holds`);
  }
});

test("a zero or negative frame time cannot move the zoom", () => {
  assert.equal(zoomStep(2.5, 3, 0, 0.85), 2.5);
});

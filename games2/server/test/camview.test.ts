import { test } from "node:test";
import assert from "node:assert/strict";
import { renderedWorldView } from "../../client/src/camview.js";

/* The phone's camera: canvas 1081x1447 (dpr 2.75), integer zoom 3 at rest,
 * pixelArt -> roundPixels. Expected values are Camera.preRender (Phaser 3.90)
 * worked by hand, NOT the function under test. */
const phone = (over = {}) => ({
  scrollX: 12256.4, scrollY: 9664.7, width: 1081, height: 1447, zoomX: 3, zoomY: 3,
  roundPixels: true, useBounds: false, clampX: (x: number) => x, clampY: (y: number) => y, ...over,
});

test("renderedWorldView is Camera.preRender's rectangle, worked by hand", () => {
  const v = renderedWorldView(phone());
  // floor(12256.4)=12256; mid = 12256+540.5; view = floor(1081/3+.5)=360; x = floor(12796.5-180+.5)=12617
  // floor(9664.7)=9664;  mid = 9664+723.5;  view = floor(1447/3+.5)=482; y = floor(10387.5-241+.5)=10147
  assert.deepEqual(v, { x: 12617, y: 10147, width: 360, height: 482 });
});

test("it follows the LIVE scroll — the rectangle Phaser exposes in update() does not", () => {
  const cam = phone();
  const stale = renderedWorldView(cam); // what preRender computed LAST frame
  cam.scrollY += 9; // updateChaseCam moved the camera this frame (a run step)
  const fresh = renderedWorldView(cam);
  assert.equal(fresh.y - stale.y, 9, "the night window must move with the camera in the SAME frame");
  assert.equal(fresh.x, stale.x);
});

test("bounds clamp and fractional zoom go through the same maths as Phaser", () => {
  const v = renderedWorldView(phone({ useBounds: true, clampX: () => 0, clampY: (y: number) => Math.min(y, 100), zoomX: 2.5, zoomY: 2.5 }));
  // clamped scroll (0, 100); view = floor(1081/2.5+.5)=432, floor(1447/2.5+.5)=579
  // x = floor(0+540.5-216+.5)=325; y = floor(100+723.5-289.5+.5)=534
  assert.deepEqual(v, { x: 325, y: 534, width: 432, height: 579 });
});

test("roundPixels floors the scroll BEFORE the half-size offset, exactly like preRender", () => {
  // width 1080: half 540, view 360 -> offset 540 - 180 + 0.5 = 360.5 (fractional, so the order shows)
  const on = renderedWorldView(phone({ width: 1080, scrollX: 100.7 }));
  const off = renderedWorldView(phone({ width: 1080, scrollX: 100.7, roundPixels: false }));
  assert.equal(on.x, 460, "floor(100.7)=100; floor(100 + 360.5) = 460");
  assert.equal(off.x, 461, "floor(100.7 + 360.5) = 461");
  const out = { x: 0, y: 0, width: 0, height: 0 };
  assert.equal(renderedWorldView(phone(), out), out, "writes into the caller's rect (no per-frame allocation)");
});

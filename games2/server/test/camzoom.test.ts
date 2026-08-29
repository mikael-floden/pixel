import test from "node:test";
import assert from "node:assert/strict";
import { cameraZoom } from "../../client/src/camzoom";

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

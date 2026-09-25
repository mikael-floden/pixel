// "DESKTOP SITE" ON A PHONE (client/src/desktopsite.ts): the page is laid out
// ~980 CSS px wide and shrunk onto the screen, so the UI draws at half size and
// a canvas backed at devicePixelRatio per CSS px carries ~2.2x the screen's
// pixels (maintainer 2026-09-25, his girlfriend's phone: backing 2390 x 3912,
// "way overkill as default"). main.ts backs at dpr / squeeze.
import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopSqueeze, SQUEEZE_MIN } from "../../client/src/desktopsite.js";
import { cameraZoom } from "../../client/src/camzoom.js";

const env = (innerWidth: number, innerHeight: number, screenWidth: number, screenHeight: number, touch = true) => ({ innerWidth, innerHeight, screenWidth, screenHeight, touch });

test("the squeeze: 1 on a device-width page, a desktop or a landscape viewport; ~2.2 on a phone in Desktop site", () => {
  assert.equal(desktopSqueeze(env(443, 921, 443, 985)), 1, "her phone, device width");
  assert.equal(desktopSqueeze(env(484, 1060, 484, 1087)), 1, "his phone");
  assert.equal(desktopSqueeze(env(988, 393, 393, 851)), 1, "his landscape viewport runs 1.16x the screen's long side: not a squeeze");
  assert.equal(desktopSqueeze(env(1920, 1080, 1920, 1080, false)), 1, "a desktop");
  assert.equal(desktopSqueeze(env(3000, 1500, 1920, 1080, false)), 1, "no touch, never");
  assert.equal(desktopSqueeze(env(980, 440, 443, 985)), 1, "Desktop site in landscape is ~1:1");
  const k = desktopSqueeze(env(980, 2036, 443, 985));
  assert.ok(Math.abs(k - 980 / 443) < 1e-9, `${k}`);
  assert.ok(k >= SQUEEZE_MIN);
  assert.equal(desktopSqueeze(null), 1);
});

test("under the squeeze the canvas backs at the screen's own pixels and the camera frames what his phone frames", () => {
  // Her phone: dpr 2.4375, 443 css px across, "Desktop site" lays out 980.
  const dpr = 2.4375;
  const k = desktopSqueeze(env(980, 2036, 443, 985));
  const rs = Math.max(1, Math.min(4, dpr) / k);
  const backing = Math.round(980 * rs);
  assert.ok(Math.abs(backing - 443 * dpr) <= 1, `${backing} backing px across, the screen has ${443 * dpr}`);
  const zoom = cameraZoom(backing, rs);
  // His: 484 css px at dpr 2.23 — 1079 backing px, zoom 2, 540 world px across.
  assert.equal(cameraZoom(1079, 2.23), 2);
  assert.equal(zoom, 2, "the same integer zoom as his phone");
  assert.ok(Math.abs(backing / zoom - 540) < 1, `${backing / zoom} world px across`);
  // Before: backed at dpr per layout px — 2389 px, zoom 5.
  assert.equal(Math.round(980 * dpr), 2389);
  assert.equal(cameraZoom(2389, dpr), 5);
});

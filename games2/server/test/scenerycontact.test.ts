// CONTACT IS WHERE THE ART MEETS THE GROUND (client/src/scenerycontact.ts):
// a table's LEGS, not the span between them; a rock's whole base. Maintainer
// 2026-09-17, on the marked screenshots: "On a table only the table legs hit
// the ground."
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTACT_ISO_SLOPE, buildContactStamp, contactBottoms, contactStampKey } from "../../client/src/scenerycontact.js";

function blank(w: number, h: number) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}
function fill(px: { w: number; data: Uint8Array | Uint8ClampedArray }, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px.data[(y * px.w + x) * 4 + 3] = 255;
}
const alphaAt = (s: { w: number; data: Uint8Array | Uint8ClampedArray }, x: number, y: number) => s.data[(y * s.w + x) * 4 + 3];

test("a table: the legs touch, the span between them does not", () => {
  const px = blank(64, 48);
  fill(px, 4, 10, 60, 16); // the top
  fill(px, 6, 16, 10, 40); // left leg
  fill(px, 54, 16, 58, 40); // right leg
  const cut = { sx: 0, sy: 0, sw: 64, sh: 48 };
  const b = contactBottoms(px, cut);
  assert.equal(b[7], 39, "the leg's bottom");
  assert.equal(b[30], 15, "the top's underside between the legs");
  const s = buildContactStamp(px, cut)!;
  assert.ok(s, "a stamp");
  assert.equal(s.footY, 39);
  assert.ok(s.points.every((p) => (p.x >= 6 && p.x < 10) || (p.x >= 54 && p.x < 58)), `contact columns are the legs only: ${JSON.stringify(s.points.map((p) => p.x))}`);
  assert.ok(alphaAt(s, 7, 39) > 150, "dark under the left leg");
  assert.ok(alphaAt(s, 55, 39) > 150, "dark under the right leg");
  assert.equal(alphaAt(s, 30, 39), 0, "nothing under the span at the footline");
  assert.ok(s.data.every((v, i) => i % 4 !== 3 || v <= 180), "never black: the peak coverage is capped");
  assert.equal(alphaAt(s, 30, 15), 0, "nothing under the top's underside");
  assert.ok(alphaAt(s, 7, 41) > 0, "the blob reaches the ground in front of the leg (the pad)");
});

test("a rock: the whole base is in contact, the crown is not", () => {
  const px = blank(40, 30);
  // A filled half-disc, flat side down at row 27.
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) {
    const dx = (x - 19.5) / 19.5, dy = (y - 27) / 27;
    if (dy <= 0 && dx * dx + dy * dy <= 1) px.data[(y * px.w + x) * 4 + 3] = 255;
  }
  const cut = { sx: 0, sy: 0, sw: 40, sh: 30 };
  const s = buildContactStamp(px, cut)!;
  assert.ok(s.points.length >= 36, `nearly every column touches (${s.points.length})`);
  assert.ok(alphaAt(s, 20, 27) > 150, "dark under the middle of the base");
  assert.ok(alphaAt(s, 2, 27) > 150, "dark under the base's end");
  assert.equal(alphaAt(s, 20, 5), 0, "the crown is not a contact");
});

test("an empty crop has no stamp; the key carries art, version and crop", () => {
  assert.equal(buildContactStamp(blank(8, 8), { sx: 0, sy: 0, sw: 8, sh: 8 }), null);
  assert.equal(contactStampKey("s3:barrels/barrel_001", { sx: 2, sy: 3, sw: 40, sh: 50 }), "s3ct:s3:barrels/barrel_001@v3:2,3,40,50");
});

test("an iso box: the whole base V touches, not only the front corner", () => {
  // A 2:1 diamond footprint 60 wide: the front corner at column 30 is the
  // lowest point, both base edges climb half a px per column from it.
  const px = blank(64, 48);
  for (let x = 2; x < 62; x++) {
    const bottom = 45 - Math.floor(Math.abs(x - 32) * CONTACT_ISO_SLOPE);
    fill(px, x, 4, x + 1, bottom + 1);
  }
  const cut = { sx: 0, sy: 0, sw: 64, sh: 48 };
  const s = buildContactStamp(px, cut)!;
  assert.equal(s.footY, 45);
  assert.ok(s.points.length >= 58, `the whole base is in contact (${s.points.length} of 60 columns)`);
  assert.ok(alphaAt(s, 4, 45 - 14) > 150, "dark under the left end of the base edge");
  assert.ok(alphaAt(s, 59, 45 - 13) > 150, "dark under the right end of the base edge");
  assert.ok(alphaAt(s, 32, 45) > 150, "dark under the front corner");
  assert.equal(alphaAt(s, 32, 20), 0, "nothing on the box's body");
});

test("a tree: the trunk touches, the canopy far above the ground line does not", () => {
  const px = blank(64, 80);
  fill(px, 4, 4, 60, 40); // the canopy, a wide block
  fill(px, 29, 40, 35, 78); // the trunk
  const s = buildContactStamp(px, { sx: 0, sy: 0, sw: 64, sh: 80 })!;
  assert.equal(s.footY, 77);
  assert.ok(s.points.every((p) => p.x >= 29 && p.x < 35), `trunk columns only: ${JSON.stringify(s.points.map((p) => p.x))}`);
  assert.equal(alphaAt(s, 10, 39), 0, "nothing under the canopy's underside");
});

test("the stamp is white with the coverage in alpha (the draw tints it with the floor height)", () => {
  const px = blank(16, 16);
  fill(px, 4, 4, 12, 12);
  const s = buildContactStamp(px, { sx: 0, sy: 0, sw: 16, sh: 16 })!;
  const i = (11 * s.w + 8) * 4;
  assert.deepEqual([s.data[i], s.data[i + 1], s.data[i + 2]], [255, 255, 255]);
  assert.ok(s.data[i + 3] > 150);
});

test("a short step in a base edge is bridged, a long one is not", () => {
  // A flat base 60 wide with a 3-column notch cut 10 px up at columns 30..32
  // (a hearth slab's step) and a 20-column bay cut 10 px up at 40..59.
  const px = blank(64, 40);
  for (let x = 2; x < 62; x++) {
    const bottom = (x >= 30 && x < 33) || (x >= 40 && x < 60) ? 27 : 37;
    fill(px, x, 4, x + 1, bottom + 1);
  }
  const s = buildContactStamp(px, { sx: 0, sy: 0, sw: 64, sh: 40 })!;
  const xs = new Set(s.points.map((p) => p.x));
  assert.ok(xs.has(31), "the notch is bridged");
  assert.ok(!xs.has(50), "the bay is not");
  assert.ok(alphaAt(s, 31, 37) > 100, "dark across the notch");
});

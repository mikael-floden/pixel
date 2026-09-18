// CONTACT IS WHERE THE ART MEETS THE GROUND (client/src/scenerycontact.ts):
// a table's LEGS, not the span between them; a rock's whole base. Maintainer
// 2026-09-17, on the marked screenshots: "On a table only the table legs hit
// the ground."
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContactStamp, contactBottoms, contactStampKey } from "../../client/src/scenerycontact.js";

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
  assert.ok(alphaAt(s, 7, 39) > 200, "dark under the left leg");
  assert.ok(alphaAt(s, 55, 39) > 200, "dark under the right leg");
  assert.equal(alphaAt(s, 30, 39), 0, "nothing under the span at the footline");
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
  assert.ok(alphaAt(s, 20, 27) > 200, "dark under the middle of the base");
  assert.ok(alphaAt(s, 2, 27) > 200, "dark under the base's end");
  assert.equal(alphaAt(s, 20, 5), 0, "the crown is not a contact");
});

test("an empty crop has no stamp; the key carries art, version and crop", () => {
  assert.equal(buildContactStamp(blank(8, 8), { sx: 0, sy: 0, sw: 8, sh: 8 }), null);
  assert.equal(contactStampKey("s3:barrels/barrel_001", { sx: 2, sy: 3, sw: 40, sh: 50 }), "s3ct:s3:barrels/barrel_001@v1:2,3,40,50");
});

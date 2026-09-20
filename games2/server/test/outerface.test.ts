// THE OUTER-FACE RULE IS GATED ON THE CELL'S OWN MEMBERSHIP (docs/lighting.md).
// The fragment's two room reads disagree while NO room is published: roomAt
// answers 1 (outdoors and in my room alike) and roomCellAt 0. The rule's first
// version read `outerFace = 1 - roomCellAt(front)` under `r > 0.5` alone, so
// with no room published EVERY wall face in the world was the outer face of a
// room nobody stood in: overMyRoom 1 on every face, no point light above the
// light's height and none of the glow field, all night (maintainer 2026-09-20
// at 251.4,284.6: "completely broken player torch"). The product with the
// cell's own membership is 0 outdoors — byte-identical to the rule's absence.
// This reads the fragment source off the client file and holds the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src", "nightlight.ts"), "utf8");

test("the fragment's outerFace is the cell's own membership times the front cell's absence, never the front test alone", () => {
  const lines = src.split("\n").map((l) => l.replace(/\/\/.*$/, ""));
  const assigns = lines.filter((l) => /^\s*outerFace\s*=/.test(l));
  assert.equal(assigns.length, 1, `one assignment of outerFace in the fragment, found ${assigns.length}`);
  const rhs = assigns[0].split("=").slice(1).join("=");
  assert.match(rhs, /^\s*roomCellAt\(cell\)\s*\*\s*\(1\.0\s*-\s*roomCellAt\(/, `outerFace is gated on roomCellAt(cell): ${rhs.trim()}`);
  // ...and roomCellAt really is 0 with no room published, which is what the gate leans on.
  const fn = src.slice(src.indexOf("float roomCellAt(vec2 cr) {"), src.indexOf("}", src.indexOf("float roomCellAt(vec2 cr) {")));
  assert.match(fn, /if \(uIndoorMix < 0\.001 \|\| uRoomOn < 0\.5\) return 0\.0;/);
  // ...while roomAt is 1 there (the two reads that disagreed).
  const ra = src.slice(src.indexOf("float roomAt(vec2 cr, float z) {"), src.indexOf("float m = step(0.5, texture2D(uRoom, uv).r);"));
  assert.match(ra, /if \(uIndoorMix < 0\.001\) return 1\.0;/);
});

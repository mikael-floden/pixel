import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaceFor } from "@nangijala/shared";

test("lava swims like water and burns: not standable, swimmable, slow, 4 HP/s", () => {
  const s = surfaceFor("lava");
  assert.equal(s.standable, false);
  assert.equal(s.swimmable, true, "you can enter it — it drains, it does not block");
  assert.ok(s.speed < surfaceFor("water").speed, "heavier going than water");
  assert.equal(s.harm, 4);
  assert.equal(surfaceFor("water").harm, undefined, "water is harmless");
});

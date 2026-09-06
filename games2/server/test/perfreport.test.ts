// THE BEACON'S ALLOWLIST — the filter that decides what reaches
// live/telemetry/perf.json. Every field the client sends must be named here or
// it is dropped silently, which is how a `lights` block written client-side on
// 2026-09-07 would have arrived empty. These tests are the guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { perfReport } from "../src/perfreport.js";

const AT = "2026-09-07T10:00:00.000Z";

test("the fields the beacon has always sent survive, clamped and rounded", () => {
  const r = perfReport(
    { build: "abc123", where: "428.5,364.5", tod: "Night", zoom: 1.234567, dpr: 3, view: "412x915", secs: 30.4, final: true, frames: { n: 120, p50: 16.66666 }, sections: { night: 4.2 }, counts: { occluders: 427 } },
    AT,
  );
  assert.equal(r.at, AT);
  assert.equal(r.build, "abc123");
  assert.equal(r.zoom, 1.23, "numbers are rounded to 2 decimals");
  assert.equal(r.final, true);
  assert.deepEqual(r.frames, { n: 120, p50: 16.67 });
  assert.deepEqual(r.counts, { occluders: 427 });
});

test("THE LIGHT BILL reaches the file: counts, switches and the device string all survive", () => {
  const r = perfReport(
    {
      frames: { n: 60 },
      lights: {
        n: 6, shadowing: 6, poolCells: 462, ambient: 0.177,
        sceneryShares: true, sceneryShadows: true, torch: false,
        scenerySources: 5, sceneryStamps: 5, emissive: 3,
        weather: "clear", gpu: "Mali-G78 MP14", backing: "1236x2745",
      },
    },
    AT,
  );
  assert.equal(r.lights!.n, 6);
  assert.equal(r.lights!.shadowing, 6, "how many lights march shadows is the cost driver");
  assert.equal(r.lights!.poolCells, 462);
  assert.equal(r.lights!.ambient, 0.18);
  assert.equal(r.lights!.sceneryShadows, true, "a boolean switch must survive as a boolean");
  assert.equal(r.lights!.torch, false, "false must survive — it is not missing data");
  assert.equal(r.lights!.gpu, "Mali-G78 MP14", "the device name decides how to read the ms");
  assert.equal(r.lights!.backing, "1236x2745");
});

test("the lights block drops junk and cannot grow without bound", () => {
  const many: Record<string, unknown> = { nested: { a: 1 }, arr: [1, 2], fn: null, undef: undefined };
  for (let i = 0; i < 40; i++) many["k" + i] = i;
  const r = perfReport({ frames: { n: 1 }, lights: many }, AT);
  assert.ok(Object.keys(r.lights!).length <= 32, "capped at 32 keys");
  assert.equal(r.lights!.nested, undefined, "objects are not values");
  assert.equal(r.lights!.arr, undefined, "arrays are not values");
  assert.equal(perfReport({ frames: { n: 1 } }, AT).lights, null, "absent stays null");
  assert.equal(perfReport({ frames: { n: 1 }, lights: [1, 2] }, AT).lights, null, "an array is not a block");
});

test("a long device string is truncated rather than rejected", () => {
  const r = perfReport({ frames: { n: 1 }, lights: { gpu: "x".repeat(500) } }, AT);
  assert.equal((r.lights!.gpu as string).length, 80);
});

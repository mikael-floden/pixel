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

test("zoomMean and jumps reach the file — the allowlist dropped them for two runs", () => {
  const r = perfReport({ frames: { n: 10 }, zoom: 2, zoomMean: 1.36, jumps: [{ at: 1, d: 40 }, "x"] }, AT);
  assert.equal(r.zoomMean, 1.36, "the mean zoom is the variable the fill maths needs");
  assert.equal(r.zoom, 2, "the instantaneous one still rides along");
  assert.equal(r.jumps!.length, 2);
  assert.equal(perfReport({ frames: { n: 1 } }, AT).zoomMean, null);
  assert.equal(perfReport({ frames: { n: 1 } }, AT).jumps, null);
});

test("the long-frame census survives the allowlist — nested blocks are not scalars", () => {
  // THIS ALLOWLIST HAS SILENTLY EATEN A FIELD THREE TIMES (lights, then
  // zoomMean/jumps, then this). The failure is always the same and always
  // invisible: the client emits it, the server drops it, and the next beacon
  // run comes back missing exactly the evidence it was run to collect. A
  // record-of-records is the shape that `mixed` drops, so it gets its own test.
  const body = {
    longBy: {
      "full:redrawGround": { n: 7, ms: 512, avg: 73.1, top: 61.2, idle: 1.4 },
      "scroll:groundSlice": { n: 12, ms: 640, avg: 53.3, top: 28.9, idle: 3.1 },
    },
    worst: Array.from({ length: 24 }, (_, i) => ({ f: i, total: 60 + i, sec: { redrawGround: 40 } })),
  };
  const r = perfReport(body, "2026-09-07T00:00:00.000Z") as Record<string, any>;
  assert.equal(r.longBy["full:redrawGround"].n, 7);
  assert.equal(r.longBy["full:redrawGround"].avg, 73.1);
  assert.equal(r.longBy["scroll:groundSlice"].ms, 640);
  // All 24 worst frames, not 8 — and long enough not to lose the tail, where
  // `mode` and `ring` live.
  assert.equal(r.worst.length, 24);
  assert.ok(r.worst[0].includes("redrawGround"), "a worst record lost its sections");
});

test("groundDrew reaches the file — the fourth field this allowlist ate", () => {
  // The client has emitted it all along (the groundDrew block in WorldScene.ts)
  // and 0 of 40 stored reports carried it, so what a ground paint actually did
  // — cells, blits, boundaries, composeMs — was invisible while exactly that
  // question was the open one. A field is emitted AND named here, together.
  const r = perfReport(
    { groundDrew: { cells: 4267, blits: 8843, boundaries: 128, underlays: 9, composed: 11, composeMs: 3.7, dropped: 0, built: 6, reused: 2, seam: true, transitionsOn: true } },
    "2026-09-07T00:00:00.000Z",
  ) as Record<string, any>;
  assert.equal(r.groundDrew.cells, 4267);
  assert.equal(r.groundDrew.blits, 8843);
  assert.equal(r.groundDrew.composeMs, 3.7);
  assert.equal(r.groundDrew.seam, true);
});

test("texFam reaches the file — the fifth field, and the one that names gapBusy", () => {
  // `texturesAdded` said 2,099 in one 30 s window of his 2026-09-08 run and
  // nothing said WHAT. A texture add is a decode plus a GPU upload on the main
  // thread, so it lands in `gapBusy` — 3.59 ms/frame, the second-biggest bucket
  // in that run and the only one no section owns. The client has grouped adds
  // by key family for the `perf()` probe all along; it was never sent.
  const r = perfReport(
    { texFam: { "t3f:": 812, "f:": 1004, "s3n:": 61, "cover:": 222 } },
    "2026-09-08T00:00:00.000Z",
  ) as Record<string, any>;
  assert.equal(r.texFam["t3f:"], 812);
  assert.equal(r.texFam["f:"], 1004);
  assert.equal(r.texFam["cover:"], 222);
});

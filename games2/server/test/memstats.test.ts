// ============================================================================
// /api/stats REPORTS THE HEAP CEILING, NOT JUST HOW BIG THE HEAP IS TODAY
// ============================================================================
//
// Maintainer, 2026-09-22, on being told nothing sets --max-old-space-size:
// "are you saying you need to change something to make it even better then
// change it!"
//
// He was right to push, and the claim he was pushing on was WRONG. I had told
// him Node sizes its old space from the cgroup limit, so doubling the container
// doubles the heap ceiling. MEASURED, node 22.22.2, inside a cgroup capped at
// 900 MiB:
//
//     process.constrainedMemory() =  900 MiB   <- Node SEES the cap
//     v8 heap_size_limit          = 8204 MiB   <- V8 IGNORED it
//
// V8 sized old space at ~half the HOST's 16 GB and never looked at the cgroup.
// A heap ceiling ABOVE the container is not a slow leak — it is an OOM KILL:
// V8 never reaches the pressure that would make it collect hard, so the kernel
// arrives first and the world dies with nothing in the log about memory. That
// is the exact failure --memory 2Gi was bought to prevent.
//
// What is NOT knowable from a dev box: whether Cloud Run's sandbox reports the
// INSTANCE limit as MemTotal — in which case V8's default is ~half the
// container and already safe — or the host's RAM, in which case it is lethal.
// That is a read of production, so the number has to be ON the endpoint. Hence
// this block, and hence these arms: a probe that reports the wrong quantity is
// worse than none, because it reads like an answer.
//
// THE ARM THAT PAYS FOR THE FILE is "limitMb is the CEILING". An
// implementation that reported heapTotal (how big the heap has grown) instead
// of heap_size_limit (how big V8 will ever let it grow) would satisfy every
// shape check and answer the opposite question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getHeapStatistics } from "node:v8";
import { totalmem } from "node:os";
import { perfStats } from "../src/rooms/WorldRoom.js";

const MB = 1048576;

test("mem.limitMb is V8's CEILING, not how big the heap is today", () => {
  const { mem } = perfStats() as any;
  const ceiling = +(getHeapStatistics().heap_size_limit / MB).toFixed(1);
  assert.equal(mem.limitMb, ceiling, "limitMb must be heap_size_limit");
  // The distinction the arm exists for: the ceiling is well above the heap in
  // any healthy process, so reporting heapTotal would be a different number.
  assert.ok(mem.limitMb > mem.heapTotalMb, `ceiling ${mem.limitMb} should exceed heapTotal ${mem.heapTotalMb}`);
  assert.ok(mem.heapTotalMb >= mem.heapUsedMb);
});

test("it separates what the flag governs from what it does not", () => {
  const { mem } = perfStats() as any;
  // nativeMb is rss MINUS the heap: the terrain grid, art buffers, brotli.
  // --max-old-space-size does nothing to this, and a bigger container is the
  // only thing that helps it — which is the whole reason both are reported.
  assert.ok(mem.nativeMb >= 0);
  assert.ok(Math.abs(mem.rssMb - mem.heapTotalMb - mem.nativeMb) < 1.0,
    `rss ${mem.rssMb} - heapTotal ${mem.heapTotalMb} should be native ${mem.nativeMb}`);
});

test("totalMb is what V8 sized itself from, constrainedMb what the cage allows", () => {
  const { mem } = perfStats() as any;
  assert.equal(mem.totalMb, +(totalmem() / MB).toFixed(1));
  // constrainedMemory() answers 0 when it cannot tell; it must never throw the
  // endpoint, and it must never come back undefined or NaN.
  assert.equal(typeof mem.constrainedMb, "number");
  assert.ok(Number.isFinite(mem.constrainedMb) && mem.constrainedMb >= 0);
});

test("every field survives JSON — an endpoint is no use if a field serialises to null", () => {
  const round = JSON.parse(JSON.stringify(perfStats()));
  assert.ok(round.mem, "mem block must survive JSON.stringify");
  for (const [k, v] of Object.entries(round.mem)) {
    assert.equal(typeof v, "number", `mem.${k} must be a number, got ${typeof v}`);
    assert.ok(Number.isFinite(v as number), `mem.${k} must be finite`);
  }
  // rss is reported twice on purpose (top level for the load bot's existing
  // readers, inside mem beside the heap it is being compared against). They
  // are read one call apart, so they may differ slightly — never wildly.
  assert.ok(Math.abs(round.rssMb - round.mem.rssMb) <= 8,
    `top-level rss ${round.rssMb} and mem.rssMb ${round.mem.rssMb} should agree`);
});

test("the dangerous configuration is DETECTABLE from these fields alone", () => {
  const { mem } = perfStats() as any;
  // This is the check a human (or ar-watch's successor) runs on the live
  // numbers: a ceiling above the cage means V8 will grow past the container
  // and be killed rather than collect. It cannot be asserted false HERE — a
  // test runner is not in a cage — but the fields must make it expressible,
  // which is exactly what reporting only rss did not.
  const overCommitted = mem.constrainedMb > 0 && mem.limitMb > mem.constrainedMb;
  assert.equal(typeof overCommitted, "boolean");
  assert.ok("limitMb" in mem && "constrainedMb" in mem);
});

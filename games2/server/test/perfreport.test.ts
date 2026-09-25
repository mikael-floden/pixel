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

test("THE LATE-BY-LOAD TABLE reaches the file whole: draws, binds and fill buckets, frames and late each", () => {
  const late: Record<string, number> = {};
  for (const [axis, tops] of [["dc", [500, 1000, 1500, 2000, 3000]], ["tb", [1000, 2500, 5000, 10000]], ["fill", [10, 15, 20, 25, 30]]] as const)
    for (const top of [...tops, "inf"]) {
      late[`${axis}_${top}`] = 100;
      late[`${axis}_${top}_late`] = 7;
    }
  assert.equal(Object.keys(late).length, 34);
  const r = perfReport({ frames: { n: 60 }, late }, AT);
  assert.deepEqual(r.late, late);
  assert.equal(perfReport({ frames: { n: 60 } }, AT).late, null, "an older client sends none");
});

test("THE PACER'S ROW reaches the file: the mode string and every number", () => {
  const pace = { mode: "auto", paced: 1, lockedFrac: 0.91, hz: 30, tickHz: 60, locks: 1, run: 902, skipped: 870, work50: 12.4, work90: 18.9, workMax: 61.2 };
  const r = perfReport({ frames: { n: 60 }, pace }, AT);
  assert.deepEqual(r.pace, pace);
  assert.equal(perfReport({ frames: { n: 60 } }, AT).pace, null, "an older client sends none");
});

test("THE TERRAIN BAKE'S ROW reaches the file", () => {
  const bake = { on: 1, chunks: 9, baked: 7, live: 1, waiting: 1, images: 212, atlases: 7, ms: 41.2, peakMs: 2.1, bakes: 3, evicted: 0, dirtied: 0, ops: 5120, opsMax: 2210, unbakeable: 0 };
  const r = perfReport({ frames: { n: 60 }, bake }, AT);
  assert.deepEqual(r.bake, bake);
  assert.equal(perfReport({ frames: { n: 60 } }, AT).bake, null, "a client without the bake sends none");
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

test("cores reaches the file — how many the phone has against the one we use", () => {
  // Every line of the client runs on the main thread, so a ground slice does
  // not run beside a frame, it runs instead of one. How many cores are idle
  // while that happens decides how many workers are worth starting, and no
  // report has ever carried the number.
  const r = perfReport({ cores: 8, dpr: 2.75 }, "2026-09-08T00:00:00.000Z") as Record<string, any>;
  assert.equal(r.cores, 8);
  assert.equal(r.dpr, 2.75);
  // Junk must not become a core count.
  assert.equal((perfReport({ cores: "lots" }, "2026-09-08T00:00:00.000Z") as Record<string, any>).cores, null);
});

test("the worker block reaches the file — strings first, or zero is ambiguous", () => {
  // A resolve worker that never booted reports every millisecond as 0, which
  // looks exactly like one that booted and was never needed. `state` is what
  // tells those apart, so the block is MIXED and not flat.
  const r = perfReport(
    { worker: { state: "ready", resolved: 4820, inFlight: 120, stale: 0, batches: 41, workerMs: 1830.4, applyMs: 61.2, bootMs: 940, regionMs: 38.1, cores: 8, error: "" } },
    "2026-09-08T00:00:00.000Z",
  ) as Record<string, any>;
  assert.equal(r.worker.state, "ready");
  assert.equal(r.worker.resolved, 4820);
  assert.equal(r.worker.workerMs, 1830.4);
  assert.equal(r.worker.cores, 8);
  // A failure must arrive as its reason, not as silence.
  const f = perfReport({ worker: { state: "failed", error: "module workers unsupported" } }, "2026-09-08T00:00:00.000Z") as Record<string, any>;
  assert.equal(f.worker.state, "failed");
  assert.equal(f.worker.error, "module workers unsupported");
});

test("the net block survives the allowlist as a record of records", () => {
  // THE TRAP THIS PINS: `mixed` keeps scalars and drops everything else, so a
  // per-family block passed through it arrives as {} — a 200 with an empty
  // answer, which is how three earlier fields were lost. `nested` is required,
  // and the assertion has to reach INSIDE a bucket or it cannot tell them apart.
  const r = perfReport(
    {
      net: {
        scenery: { n: 31, cached: 31, net: 0, kb: 0, decKb: 412.5, slow: 9, p50: 2.1, p90: 18.4, max: 41.7 },
        tiles3: { n: 214, cached: 214, net: 0, kb: 0, decKb: 190.2, slow: 1, p50: 0.6, p90: 1.4, max: 9.2 },
      },
      netWorst: ["41.7ms cache 96.0kb /assets/scenery/ancient_trees/ancient_tree_002/sprite.webp"],
    },
    "2026-09-08T00:00:00.000Z",
  ) as Record<string, any>;
  assert.equal(r.net.scenery.max, 41.7);
  assert.equal(r.net.scenery.cached, 31);
  assert.equal(r.net.tiles3.n, 214);
  // `net: 0` must survive as the number 0 — it is the whole answer to "are we
  // re-requesting art", and a dropped key reads the same as a zero.
  assert.equal(r.net.scenery.net, 0);
  assert.equal(r.netWorst.length, 1);
  assert.match(r.netWorst[0], /ancient_tree_002/);
  // Junk is not a report.
  assert.equal((perfReport({ net: "none" }, "2026-09-08T00:00:00.000Z") as Record<string, any>).net, null);
});

test("the heap block reaches the file — it was dropped for five commits", () => {
  // The client has sent `heap` since db459b988a and this allowlist silently
  // discarded every sample, which is the FIFTH field lost this way. It is a
  // flat record of numbers, so `mixed` is right — but the assertion has to
  // name the fields, because a dropped key and a zero read identically and
  // that is exactly how the earlier four went unnoticed.
  const r = perfReport(
    { heap: { meanMb: 412.6, maxMb: 501.3, limitMb: 2048, grewMb: 188.4, grewMbPerSec: 6.3, drops: 11 } },
    "2026-09-08T00:00:00.000Z",
  ) as Record<string, any>;
  assert.equal(r.heap.grewMbPerSec, 6.3);
  assert.equal(r.heap.drops, 11);
  assert.equal(r.heap.maxMb, 501.3);
  // A window with no sample must arrive as null, not as a zeroed heap — "no
  // data" and "allocated nothing" are opposite readings of the same question.
  assert.equal((perfReport({ heap: null }, "2026-09-08T00:00:00.000Z") as Record<string, any>).heap, null);
});

test("the texUp block reaches the file — it measures the theory under test", () => {
  const r = perfReport(
    {
      texUp: { n: 957, ms: 812.4, msPerSec: 27.1, mpx: 118.3, p50: 0.31, p90: 2.4, p99: 11.8, max: 41.2, slow: 63, installed: true },
      texUpWorst: ["41.2ms 592x644 (381kpx)"],
    },
    "2026-09-08T00:00:00.000Z",
  ) as Record<string, any>;
  assert.equal(r.texUp.msPerSec, 27.1);
  assert.equal(r.texUp.max, 41.2);
  assert.equal(r.texUp.slow, 63);
  // `installed` is the difference between "uploads cost nothing" and "the probe
  // never wrapped anything" — opposite readings that both show up as zeros.
  assert.equal(r.texUp.installed, true);
  assert.match(r.texUpWorst[0], /381kpx/);
});


test("groundDrew carries every key the client sends — it was capped one short", () => {
  const body = { groundDrew: Object.fromEntries([...Array(19)].map((_, i) => [`k${i}`, i])) };
  const r = perfReport(body, "2026-09-08T00:00:00.000Z") as Record<string, any>;
  // 19 keys is what the client sends after subBatches/subBrackets/subPerBracket/
  // subMax/texBinds/maxTex; a cap of 12 dropped seven of them, silently.
  assert.equal(Object.keys(r.groundDrew).length, 19);
  assert.equal(r.groundDrew.k18, 18);
});

test("the context, round-trip, cpu and gpu blocks reach the file — added with the fields that emit them", () => {
  const r = perfReport(
    {
      frames: { n: 900, p50: 16.7, p90: 20, p99: 40, max: 120, le17: 700, le34: 150, le50: 30, le100: 15, gt100: 5, mean: 18.2, rafHz: 60 },
      run: { runId: "ab12cd34", winIdx: 3, sinceLoadS: 95, visible: true, zone: 10, hops: 1, hopJoinMs: 812, moveFrac: 0.7, runFrac: 0.2, travelCells: 41.5, connType: "4g", ua: "Mozilla/5.0 (Linux; Android 14)" },
      rtt: { n: 590, p50: 83, p90: 140, p99: 260, max: 612, patches: 610, patchHz: 20.3, reconnects: 0 },
      cpu: { bench: "xorshift400k", scoreMs: 4.7 },
      gpu: { avail: false, reason: "no EXT_disjoint_timer_query_webgl2", n: 0, p50: 0 },
      counts: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`c${i}`, i])),
    },
    AT,
  );
  assert.equal(r.frames?.rafHz, 60, "the histogram and display rate ride in frames — 12 keys, so the old cap of 12 was one short");
  assert.equal(r.frames?.gt100, 5);
  assert.equal(r.run?.runId, "ab12cd34");
  assert.equal(r.run?.visible, true, "booleans survive in run");
  assert.equal(r.run?.hopJoinMs, 812);
  assert.equal(r.rtt?.p50, 83);
  assert.equal(r.rtt?.patchHz, 20.3);
  assert.equal(r.cpu?.scoreMs, 4.7);
  assert.equal(r.cpu?.bench, "xorshift400k");
  assert.equal(r.gpu?.avail, false, "an absent GPU timer says so instead of reporting 0 ms");
  assert.equal(r.gpu?.reason, "no EXT_disjoint_timer_query_webgl2");
  assert.equal(Object.keys(r.counts ?? {}).length, 50, "counts carries the four new means beside the 40 it had");
});

test("longWhere and a whole worst record reach the file — the place census and the evidence tail", () => {
  const rec = { f: 12, total: 212.4, other: 30, sec: { redrawGround: 120, occCull: 40 }, mode: "full", composed: 9, composeMs: 60, bnd: 8, defer: 2, owed: 3, tex: 14, files: 2, objs: 40, ring: 11, gl: { texNew: 3 }, burst: 2, q: 1, dl: 4259, occ: 3648, at: "276.6,178.9", z: 3, t: 18422 };
  const r = perfReport(
    {
      frames: { n: 100 },
      longWhere: { "272,176": { n: 14, ms: 1802, avg: 128.7, worst: 212 }, "264,216": { n: 3, ms: 260, avg: 86.7, worst: 120 } },
      worst: [rec],
    },
    AT,
  );
  assert.equal(r.longWhere?.["272,176"]?.n, 14, "the place census is a record of records, not scalars");
  assert.equal(r.longWhere?.["272,176"]?.worst, 212);
  const back = JSON.parse(r.worst![0]!);
  assert.deepEqual(back, rec, "a worst record arrives WHOLE — the cap cut the evidence tail twice before");
  assert.equal(back.at, "276.6,178.9", "and it says where the frame happened");
});

/* THE ZONE CROSSINGS (WorldScene's `zone` block). A crossing can only be
 * judged on HIS device — a headless client binds the new room hundreds of ms
 * after the join and never meets the window a phone does — so the beacon
 * carries one folded row per hop, and the whitelist has to let a record of
 * records through (the class of field that has been silently dropped twice). */
test("the zone block survives the whitelist: hops and the folded crossing rows", () => {
  const row = { zone: 10, joinMs: 412, stateMs: 486, boundMs: 488, snapPlayers: 1, snapMonsters: 47, inView: 0, removed: 6, frames: 96, visMed: 21, visFloor: 19 };
  const r = perfReport({ frames: { n: 100 }, zone: { hops: 3, last: [row] } }, AT);
  assert.equal(r.zone?.hops, 3);
  assert.deepEqual((r.zone?.last as unknown[])?.[0], row, "a crossing row arrives WHOLE — every field is the evidence");
  assert.ok(!perfReport({ frames: { n: 1 } }, AT).zone, "a window with no crossing carries no block");
});

test("longWhy — why the long frames were long — survives the allowlist", () => {
  // The fourth field this allowlist would otherwise eat silently: the client
  // classifies every long frame (wait | task | gc) and the ground-path
  // decision rests on which population `cells:unattributed` turns out to be.
  const r = perfReport({ frames: { n: 10 }, longWhy: { n: 42, wait: 39, task: 2, gc: 1, taskMs: 217, waitIdleMs: 1650, gcMb: 31 } }, AT) as Record<string, any>;
  assert.equal(r.longWhy.wait, 39);
  assert.equal(r.longWhy.task, 2);
  assert.equal(r.longWhy.taskMs, 217);
  assert.equal(r.longWhy.gcMb, 31);
  assert.equal(perfReport({ frames: { n: 1 } }, AT).longWhy, null);
});

test("the resolver's bill, the felt lag and the ambient rows reach the file — and the run's settings survive as strings", () => {
  // 2026-09-19, before his run on six days of new code: the resolver has run
  // on the frame thread in every run he has sent (worker off) with no line
  // of its own, the ambient effects ride the scene's UPDATE event outside
  // every section, and no report has ever said how late a tap was answered.
  // Same allowlist, same trap: emitted AND named here, in one commit.
  const r = perfReport(
    {
      run: { runId: "a", winIdx: 1, fade: "r4 a0.46 f4", ambient: "forced:2", lane: "fast" },
      resolve: { cells: 1200, ms: 8.4, usPerCell: 7, boundaries: 300, boundaryMs: 1.2, decks: 4, deckMs: 0, fadeScans: 1100, fadeVisits: 80300, visitsPerScan: 73, fades: 41, worker: "off" },
      input: { avail: true, n: 3, slow: 1, delayP50: 20, delayP90: 88, delayMax: 88, durP50: 40, durP90: 120, durMax: 120, worst: "pointerdown 120ms" },
      ambient: { birds: { ms: 0.12, peak: 1.4, frames: 1500 }, _: { mode: "zone", active: "birds" } },
      groundDrew: { cells: 10, fades: 3, fadeTex: 2 },
    },
    AT,
  ) as Record<string, any>;
  assert.equal(r.run.fade, "r4 a0.46 f4", "the fade dials are what the scan costs");
  assert.equal(r.run.ambient, "forced:2");
  assert.equal(r.run.lane, "fast");
  assert.equal(r.resolve.cells, 1200);
  assert.equal(r.resolve.fadeVisits, 80300);
  assert.equal(r.resolve.worker, "off", "a string, so 0 ms cannot mean 'somewhere else'");
  assert.equal(r.input.avail, true, "a boolean switch must survive as a boolean");
  assert.equal(r.input.delayP90, 88);
  assert.equal(r.input.worst, "pointerdown 120ms");
  assert.equal(r.ambient.birds.peak, 1.4, "nested rows are records, not scalars");
  assert.equal(r.ambient._.mode, "zone");
  assert.equal(r.groundDrew.fades, 3);
  assert.equal(r.groundDrew.fadeTex, 2);
  assert.equal(perfReport({}, AT).resolve, null, "absent stays null");
  assert.equal(perfReport({}, AT).input, null);
  assert.equal(perfReport({}, AT).ambient, null);
  // 36 sections arrive with `preUpdate` and `hooks`; the cap must keep the last ones.
  const secs = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`s${i}`, i + 1]));
  assert.equal((perfReport({ sections: secs }, AT) as Record<string, any>).sections.s39, 40, "the sections cap is one short again");
});

test("the beacon's delivery ledger reaches the file — the run says what became of its posts", () => {
  const r = perfReport(
    { frames: { n: 60 }, beacon: { sent: 4, ok: 2, failed: 2, retried: 1, lastStatus: 502, lastError: "HTTP 502 PUT perf.json: HTTP 409", lastOkWin: 2, queued: 1 } },
    AT,
  ) as { beacon: Record<string, unknown> };
  assert.deepEqual(r.beacon, { sent: 4, ok: 2, failed: 2, retried: 1, lastStatus: 502, lastError: "HTTP 502 PUT perf.json: HTTP 409", lastOkWin: 2, queued: 1 });
});

test("the LoAF split, its invokers and the group census reach the file — the state string first", () => {
  // client/src/perfloaf.ts: the browser's own split of every long frame.
  // `state` is the first thing to read — "unsupported" must never read as "no
  // long frames" — so the block is MIXED; the invokers and the group census
  // are records of records and go through `nested`.
  const r = perfReport(
    {
      loaf: { state: "on", n: 21, ms: 1180.5, pre: 402.1, raf: 690.3, dom: 88.1, block: 410, forced: 3.2 },
      loafBy: { "FrameRequestCallback": { n: 21, ms: 688 }, "WebSocket.onmessage": { n: 9, ms: 301.5 }, "Worker.onmessage": { n: 4, ms: 61 } },
      longGroup: { "cells:idle": { n: 12, ms: 590, avg: 49.2, top: 26.1 }, "scroll:occ": { n: 7, ms: 380, avg: 54.3, top: 24 } },
    },
    AT,
  ) as Record<string, any>;
  assert.equal(r.loaf.state, "on");
  assert.equal(r.loaf.n, 21);
  assert.equal(r.loaf.pre, 402.1);
  assert.equal(r.loaf.raf, 690.3);
  assert.equal(r.loaf.dom, 88.1);
  assert.equal(r.loafBy["WebSocket.onmessage"].ms, 301.5);
  assert.equal(r.loafBy["Worker.onmessage"].n, 4);
  assert.equal(r.longGroup["cells:idle"].top, 26.1);
  assert.equal(r.longGroup["scroll:occ"].n, 7);
  assert.equal(perfReport({ frames: { n: 1 } }, AT).loaf, null, "absent stays null");
});

test("a worst record with the GL counters, the gap ledger and its LoAF entry arrives whole", () => {
  // The cap has twice cut a record mid-JSON; the counters, the ledger and the
  // browser's split add ~400 chars to a record that was 900. The reader
  // JSON.parses every record, so a truncated one is a lost frame.
  const rec = {
    f: 2446, total: 85.4, other: 0.6,
    sec: { glEnd: 0.4, groundSlice: 32.3, occCull: 1.2, artTick: 0.5, avatarLoop: 0.7, monsterLoop: 1.3, stepNpcs: 0.3, litObjects: 0.5, lighting: 0.7, depthSort: 1, render: 4.7, gapBusy: 39, gapIdle: 1.8 },
    mode: "scroll", composed: 0, composeMs: 0, bnd: 0, defer: 0, owed: 0, tex: 1, files: 0, objs: 0, ring: 779,
    gl: { brk: { "ground-rt-a": [1, 0.1, 0.4], "cover-E": [2, 0, 0.3], "cover-C": [2, 0, 0], "cover-O": [3, 0, 0] }, texNew: 0, texDel: 0, fbNew: 0, fbDel: 0, upKb: 131, capSw: 0, dc: 41, vt: 26412, fill: 11.62, fillX: 2.4, fb: 9, cl: 8, clMpx: 4.19, rd: 0 },
    glPrev: { brk: { "ground-rt-a": [1, 0, 0.7], "cover-E": [2, 0, 0.1], "cover-C": [2, 0, 0], "cover-O": [3, 0, 0] }, texNew: 0, texDel: 0, fbNew: 0, fbDel: 0, upKb: 135, capSw: 0, dc: 39, vt: 25100, fill: 10.9, fillX: 2.4, fb: 9, cl: 8, clMpx: 4.19, rd: 0 },
    lag: 37.2, gap: { net: 36.8, art: 0.4 },
    burst: 1, q: 0, dl: 7027, occ: 6173, at: "254.3,186.3", z: 1.36, t: 26777,
    loaf: { pre: 38.1, raf: 46.2, dom: 1.1, by: [["FrameRequestCallback", 46], ["WebSocket.onmessage", 36.5]] },
  };
  const r = perfReport({ worst: [rec] }, AT) as Record<string, any>;
  const back = JSON.parse(r.worst[0]);
  assert.equal(back.loaf.pre, 38.1);
  assert.equal(back.gap.net, 36.8);
  assert.equal(back.gl.fill, 11.62);
  assert.equal(back.glPrev.dc, 39);
  assert.equal(back.lag, 37.2);
});

test("the counts cap has headroom for the GPU counters, the gap ledger and the rAF lag", () => {
  // 58 keys arrived on 2026-09-12; fourteen more ride now. `flat` keeps the
  // first N and says nothing, so the cap is proved here, not assumed.
  const counts: Record<string, number> = {};
  for (let i = 0; i < 80; i++) counts[`k${i}`] = i;
  counts.glFillMpx = 9.1;
  counts.gapNetMs = 412.5;
  counts.rafLagMean = 2.31;
  const r = perfReport({ counts }, AT) as Record<string, any>;
  assert.equal(r.counts.glFillMpx, 9.1);
  assert.equal(r.counts.gapNetMs, 412.5);
  assert.equal(r.counts.rafLagMean, 2.31);
  assert.ok(Object.keys(r.counts).length >= 83);
});

test("the ambient block holds every effect, the mode row, the mount's own parts and the field's counters", () => {
  // 24 effects plus `_` was already one over the old cap of 24: the mode row
  // was the one dropped. The mount's `_env`/`_gloom`/`_director`/`_frame`
  // rows and the `_zone` counters (games-perf 2026-09-23) ride beside them.
  const ambient: Record<string, Record<string, number | string>> = {};
  for (let i = 0; i < 24; i++) ambient[`effect${i}`] = { ms: 0.1, peak: 1, frames: 900 };
  ambient._ = { mode: "zone", active: "birds" };
  ambient._env = { ms: 1.2, peak: 9, frames: 300 };
  ambient._gloom = { ms: 18.4, peak: 91, frames: 300 };
  ambient._director = { ms: 2.1, peak: 30, frames: 300 };
  ambient._frame = { ms: 0.05, peak: 2, frames: 900 };
  ambient._zone = { picks: 3200, resolves: 9100, refreshes: 6, pruned: 3, cells: 40000, blur: 21000, buckets: 5900, zones: 96, ruled: 1 };
  const r = perfReport({ ambient }, AT) as Record<string, any>;
  assert.equal(Object.keys(r.ambient).length, 30);
  assert.equal(r.ambient._.mode, "zone");
  assert.equal(r.ambient._gloom.ms, 18.4);
  assert.equal(r.ambient._zone.resolves, 9100);
  assert.equal(r.ambient._zone.ruled, 1, "nine counters: the inner cap must hold them all");
});

/* WHEN AS WELL AS HOW LONG (2026-09-23, his ask): the section peaks with their
 * bounds, the clocks in counts, the LoAF window's worst with its start, the
 * ambient rows' peak bounds and foam's six peak fields, and a worst record
 * that carries a full timeline — none may be cut by a cap. */
test("each section's peak with its start and end reaches the file, and the counts' clocks", () => {
  const sectionsPeak: Record<string, { ms: number; t0: number; t1: number }> = {};
  for (let i = 0; i < 60; i++) sectionsPeak[`s${i}`] = { ms: 1.5, t0: 100000 + i, t1: 100001.5 + i };
  sectionsPeak.hooks = { ms: 648.6, t0: 1234567.8, t1: 1235216.4 };
  const counts: Record<string, number> = {};
  for (let i = 0; i < 110; i++) counts[`k${i}`] = i;
  counts.clock0 = 1790193547327;
  counts.winT0 = 900000.1;
  counts.winT1 = 930000.4;
  counts.gapNetPeakMs = 68.2;
  counts.gapNetPeakT0 = 912345.6;
  const r = perfReport({ sectionsPeak, counts }, AT) as Record<string, any>;
  assert.equal(Object.keys(r.sectionsPeak).length, 61);
  assert.deepEqual(r.sectionsPeak.hooks, { ms: 648.6, t0: 1234567.8, t1: 1235216.4 });
  assert.equal(r.counts.clock0, 1790193547327, "an epoch in ms is over the old 1e9 value cap and must pass");
  assert.equal(r.counts.winT1, 930000.4);
  assert.equal(r.counts.gapNetPeakT0, 912345.6);
  assert.ok(Object.keys(r.counts).length >= 115);
});

test("the LoAF window's worst frame and its start, the ambient peaks' bounds and foam's peak fields reach the file", () => {
  const loaf = { state: "on", n: 20, ms: 3161, pre: 1615.2, raf: 1535.3, dom: 10.7, block: 900, forced: 2.5, worstMs: 786.9, worstT0: 1234500.5 };
  const ambient: Record<string, Record<string, number | string>> = {
    mist: { ms: 0.4, peak: 12.5, frames: 1800, t0: 1234000.1, t1: 1234012.6 },
    "foam:parts": { resolves: 10, bakes: 10, bakeMs: 3, installs: 10, texMs: 1.2, scans: 60, scanMs: 200, picks: 300, live: 40, sprites: 40, queued: 0, bakePeak: 0.9, bakePeakT0: 1234001, texPeak: 2.1, texPeakT0: 1234002, scanPeak: 4.4, scanPeakT0: 1234003 },
  };
  const r = perfReport({ loaf, ambient }, AT) as Record<string, any>;
  assert.equal(r.loaf.worstT0, 1234500.5);
  assert.equal(r.ambient.mist.t1, 1234012.6);
  assert.equal(r.ambient["foam:parts"].scanPeakT0, 1234003, "17 fields: the inner cap must hold them all");
});

test("a worst record carrying a 120-region timeline arrives whole", () => {
  const tl = Array.from({ length: 120 }, (_, i) => [`section${i % 12}`, +(i * 0.7).toFixed(1), +(i * 0.7 + 0.5).toFixed(1)]);
  const rec = { total: 786.9, sec: { hooks: 648.6 }, mode: "scroll", at: "222.5,198.1", z: 2.75, t: 12000, dl: 3000, occ: 400, gl: { dc: 700, vt: 4200, fill: 3.1 }, lag: 2.1, pt0: 1234567.8, wall: 1790193547327, tl, loaf: { t0: 1234560.1, t1: 1235350.2, pre: 3.1, raf: 780.2, dom: 3.6, by: [["FrameRequestCallback", 779]] } };
  const r = perfReport({ worst: [rec] }, AT) as Record<string, any>;
  const back = JSON.parse(r.worst[0]);
  assert.equal(back.tl.length, 120);
  assert.equal(back.wall, 1790193547327);
  assert.equal(back.loaf.t1, 1235350.2);
});

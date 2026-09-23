// WHEN, NOT ONLY HOW LONG (client/src/perftimeline.ts, gapledger.ts,
// perfloaf.ts): every timed region's start and end on performance.now(), the
// frame's timeline compacted for a worst record, the waits between regions,
// and the window peaks that carry their own start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tlArm, tlMark, tlTake, tlCompact, tlWaits, TL_CAP, TL_KEEP, clock0 } from "../../client/src/perftimeline";
import { gapArm, gapBill, gapFrameTake, gapWindowTake } from "../../client/src/gapledger";
import { loafSplit } from "../../client/src/perfloaf";

test("a mark is taken only while armed, in the order the regions ended, and the cap counts what it refused", () => {
  tlArm(() => false);
  tlMark("update", 10, 20);
  assert.deepEqual(tlTake(), { marks: [], dropped: 0 }, "unarmed: nothing kept");
  tlArm(() => true);
  tlMark("hooks", 12, 18);
  tlMark("update", 10, 20);
  const t = tlTake();
  assert.deepEqual(t.marks, [["hooks", 12, 18], ["update", 10, 20]]);
  assert.equal(t.dropped, 0);
  assert.deepEqual(tlTake().marks, [], "a take resets");
  for (let i = 0; i < TL_CAP + 5; i++) tlMark(`m${i}`, i, i + 1);
  const full = tlTake();
  assert.equal(full.marks.length, TL_CAP);
  assert.equal(full.dropped, 5);
  assert.ok(TL_KEEP < TL_CAP);
  tlArm(() => false);
});

test("a record's timeline is sorted by start, relative to the frame, 0.1 ms — and a region that ran ahead of the frame is negative", () => {
  const tl = tlCompact([["render", 1050.26, 1058.91], ["gap:net", 990.5, 1001.25], ["update", 1002.04, 1050.2]], 1002);
  assert.deepEqual(tl, [["gap:net", -11.5, -0.8], ["update", 0, 48.2], ["render", 48.3, 56.9]]);
  assert.equal(tlCompact([["a-very-long-section-name-indeed", 0, 1]], 0)[0][0].length, 24);
  // marks at the timer's noise floor are dropped; over the cap the longest stay, in start order
  const many: [string, number, number][] = [];
  for (let i = 0; i < 200; i++) many.push([`m${i}`, i * 2, i * 2 + (i % 3 === 0 ? 0.01 : 0.2 + (i % 7))]);
  many.push(["hooks", 401, 401.02]); // the skeleton: kept even at the noise floor
  many.push(["render", 402, 402.3]);
  const c = tlCompact(many, 0, 50);
  assert.equal(c.length, 50);
  assert.ok(c.some((m) => m[0] === "hooks") && c.some((m) => m[0] === "render"), "the frame's skeleton is always there");
  const rest = c.filter((m) => m[0] !== "hooks" && m[0] !== "render");
  assert.ok(rest.every((m) => m[2] - m[1] >= 0.05), "no noise-floor mark kept");
  assert.ok(c.every((m, i) => i === 0 || m[1] >= c[i - 1][1]), "sorted by start");
  // the 48 longest of the ~133 others: durations 6.2 (19 of them), 5.2 (19), then 4.2 — nothing shorter
  assert.ok(rest.every((m) => m[2] - m[1] >= 4.2 - 1e-9), `the longest, shortest kept ${Math.min(...rest.map((m) => m[2] - m[1]))}`);
});

test("the waits are the gaps between one region's end and the next one's start; nesting and overlap wait nothing", () => {
  const waits = tlWaits([["gap:net", -11.5, -0.8], ["update", 0, 48.2], ["hooks", 3, 12], ["render", 48.3, 56.9], ["gap:compose", 70, 75]]);
  // the socket ended at -0.8, update began at 0: 0.8 waited; hooks nests in update: 0;
  // render began 0.1 after update ended; compose began 13.1 after render ended.
  assert.deepEqual(waits, [0, 0.8, 0, 0.1, 13.1]);
});

test("the epoch offset places a performance.now() timestamp on the real-time clock", () => {
  const c = clock0();
  const now = Date.now();
  assert.ok(Math.abs(c + performance.now() - now) < 50, `clock0 ${c} + now() vs Date.now() ${now}`);
});

test("the gap ledger keeps each name's worst handler with its start, and marks the timeline as gap:<name>", () => {
  gapArm(() => true);
  tlArm(() => true);
  tlTake();
  gapBill("net", 3.2, 1000);
  gapBill("net", 9.5, 1100);
  gapBill("net", 1.1, 1200);
  gapBill("compose", 4, 1300);
  assert.deepEqual(gapFrameTake(), { net: 13.8, compose: 4 });
  const w = gapWindowTake();
  assert.equal(w.gapNetMs, 13.8);
  assert.equal(w.gapNetPeakMs, 9.5);
  assert.equal(w.gapNetPeakT0, 1090.5, "the peak's start: its end minus its ms");
  assert.equal(w.gapComposePeakT0, 1296);
  assert.deepEqual(gapWindowTake(), {}, "a take resets the peaks too");
  const marks = tlTake().marks;
  assert.deepEqual(marks.map((m) => m[0]), ["gap:net", "gap:net", "gap:net", "gap:compose"]);
  assert.deepEqual(marks[1], ["gap:net", 1090.5, 1100]);
  gapArm(() => false);
  tlArm(() => false);
});

test("a long frame's split carries the browser's own bounds for the record to keep", () => {
  const s = loafSplit({ startTime: 1000.26, duration: 90.13, renderStart: 1030, styleAndLayoutStart: 1080 });
  assert.equal(s.t0, 1000.26);
  assert.equal(+s.t1.toFixed(2), 1090.39);
});

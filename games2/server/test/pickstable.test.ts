// ============================================================================
// THE BASE-TILE PICK IS STABLE WHEN THE TILE POOL CHANGES
// ============================================================================
//
// Maintainer 2026-09-25: "changing the member list moves every bucket — that
// must have been what I noticed. Can you make it more stable?"
//
// He notices it because he edits the sets LIVE from the wiki
// (live/tuning/base_tile_sets.json), so adding one tile re-tiles the world
// under him. The pick was never random — it is 100% reproducible on a re-roll
// and there is no Math.random anywhere in tiles3 or render3 — but it was never
// STABLE: pickWeighted walks a cumulative whose TOTAL moves with the pool, so
// every bucket boundary shifts at once.
//
// THESE ARMS ARE THE CASE FOR THE CHANGE, and arm 1 is the one that pays for
// the file: it measures the churn of the CURRENT rule, so the number he was
// promised is in the repo rather than in a chat message.
//
// NOT WIRED IN YET. maps2/pipeline/render3.py IS the spec (the parity fixture
// imports it and records what its own functions return) and
// wiki/lib/basesets.mjs is a third implementation, so this rule cannot change
// in games2 alone. Requests are out to both. Until then pickWeighted stays in
// the resolver and this file guards the replacement, the vectors the other two
// domains port against, and the promise that it costs nothing to carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fnv1a, unitHash, pickWeighted, log2fx, pickStable, WEIGHT_SCALE } from "../../client/src/tiles3.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const N = 40000;
const cellOf = (i: number) => `grass|${i % 200}|${(i / 200) | 0}`;
const keys = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

const runStable = (k: readonly string[], w: readonly number[]) =>
  Array.from({ length: N }, (_, i) => pickStable(k, w, cellOf(i)));
const runToday = (w: readonly number[]) =>
  Array.from({ length: N }, (_, i) => pickWeighted(w, unitHash(`bts1|tile|1|${i % 200}|${(i / 200) | 0}`)));
const kept = (a: number[], b: number[]) => (a.filter((v, i) => v === b[i]).length / N) * 100;

const K6 = keys(6);
const W6 = [1, 1, 1, 1, 1, 1];

test("arm 1: TODAY's rule churns half the world when a tile is added", () => {
  const before = runToday(W6);
  const afterAdd = runToday([...W6, 1]);
  const afterNudge = runToday([1, 1, 1, 1, 1, 1.2]);
  const add = kept(before, afterAdd);
  const nudge = kept(before, afterNudge);
  console.log(`[pickstable] TODAY  add a 7th: ${add.toFixed(1)}% kept   weight +20%: ${nudge.toFixed(1)}% kept`);
  assert.ok(add < 60, `the churn being fixed: expected well under 60% kept, measured ${add.toFixed(1)}%`);
  // ...and it IS deterministic — the complaint was never about randomness.
  assert.deepEqual(runToday(W6), before, "the same data gives the same answer, every time");
});

test("arm 2: the stable pick keeps what it can, and it is near the optimum", () => {
  const before = runStable(K6, W6);
  const add = kept(before, runStable([...K6, "m6"], [...W6, 1]));
  const nudge = kept(before, runStable(K6, [1, 1, 1, 1, 1, 1.2]));
  const optimum = (100 * 6) / 7;
  console.log(`[pickstable] STABLE add a 7th: ${add.toFixed(1)}% kept (optimum ${optimum.toFixed(1)}%)   weight +20%: ${nudge.toFixed(1)}% kept`);
  // Only the cells the NEW member wins may move; nothing else can, because no
  // existing member's score depends on any other member.
  assert.ok(add > optimum - 3, `expected ~${optimum.toFixed(1)}%, measured ${add.toFixed(1)}%`);
  assert.ok(nudge > 95, `a weight nudge should barely move anything, measured ${nudge.toFixed(1)}%`);
  assert.deepEqual(runStable(K6, W6), before, "still perfectly deterministic");
});

test("arm 3: REMOVING a tile only moves the cells that tile had", () => {
  // The other half of the promise, and the one he will hit when he rejects a
  // tile in the wiki — a verdict filters the pool, so a reject is a removal.
  const before = runStable(K6, W6);
  const without = runStable(K6.slice(0, 5), W6.slice(0, 5));
  const hadLast = before.filter((v) => v === 5).length;
  let movedButDidNotHaveIt = 0;
  for (let i = 0; i < N; i++) if (before[i] !== 5 && before[i] !== without[i]) movedButDidNotHaveIt++;
  console.log(`[pickstable] removing one of six: ${hadLast} cells had it, ${movedButDidNotHaveIt} others moved`);
  assert.equal(movedButDidNotHaveIt, 0, "a cell that did not hold the removed tile must not move at all");
});

test("arm 4: it is still weight-proportional, and 0 still means never", () => {
  const w = [1, 2, 4, 0.5, 0.1, 0.05];
  const hist = new Array(6).fill(0);
  for (const v of runStable(K6, w)) if (v >= 0) hist[v]++;
  const total = w.reduce((s, x) => s + x, 0);
  for (let i = 0; i < 6; i++) {
    const got = (hist[i] / N) * 100;
    const want = (w[i] / total) * 100;
    assert.ok(Math.abs(got - want) < Math.max(1, want * 0.12),
      `member ${i}: want ~${want.toFixed(1)}%, got ${got.toFixed(1)}%`);
  }
  const zeroed = runStable(K6, [1, 1, 1, 1, 1, 0]);
  assert.equal(zeroed.filter((v) => v === 5).length, 0, "a zero weight is never picked");
  assert.equal(pickStable(K6, [0, 0, 0, 0, 0, 0], "x"), -1, "nothing pickable returns -1, as pickWeighted does");
});

test("arm 5: integer-only — the vectors maps2 and wiki port against", () => {
  // If a port disagrees on ONE of these it disagrees on the world. They are
  // duplicated verbatim in games2/docs/tiles3-stablepick.md.
  const LOG2FX: Array<[number, number]> = [
    [0, 0], [1, 0], [2, 65536], [3, 103872], [255, 523917],
    [65535, 1048574], [0xdeadbeef, 2083966], [0xffffffff, 2097151],
  ];
  for (const [h, want] of LOG2FX) assert.equal(log2fx(h), want, `log2fx(${h})`);
  // Every value is an integer in range — no float can leak into the comparison.
  for (const [h] of LOG2FX) {
    const v = log2fx(h);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 32 * 65536, `log2fx(${h}) out of range`);
  }
  assert.equal(WEIGHT_SCALE, 1000);
  // The products the comparison forms must stay exact in a double.
  assert.ok(32 * 65536 * (30 * WEIGHT_SCALE) < Number.MAX_SAFE_INTEGER);
  // Keys m0..m5 with weights [1, 2, 4, 0.5, 0.1, 0.05]. A port that disagrees
  // on one of these disagrees on the world; they are LITERALS on purpose, so
  // this cannot pass by comparing the implementation to itself.
  const W = [1, 2, 4, 0.5, 0.1, 0.05];
  const PICKS: Array<[string, number]> = [["grass|0|0", 2], ["grass|1|0", 2], ["grass|7|3", 1]];
  for (const [cell, want] of PICKS) assert.equal(pickStable(K6, W, cell), want, `pickStable(${cell})`);
  assert.equal(fnv1a("bts1|tile|1|0|0"), 1995477220, "the hash itself is unchanged — vectors from basesets.mjs");
});

test("arm 6: NOT WIRED IN — the shipped resolver still uses pickWeighted", () => {
  // render3.py is the spec and basesets.mjs is a third implementation; flipping
  // one of three is exactly what the parity law forbids. This arm goes red the
  // day someone wires it in without the other two, which is the failure this
  // whole file is arranged around.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "src", "tiles3.ts"), "utf8");
  const resolverUses = src.match(/pickWeighted\(\s*pool\.weights/);
  assert.ok(resolverUses, "the resolver still picks with pickWeighted");
  assert.ok(!/pickStable\(\s*pool/.test(src), "pickStable must not be wired into the resolver until maps2 and wiki carry it");
  assert.ok(src.includes("bts1|tile|"), "still on the bts1 namespace");
});

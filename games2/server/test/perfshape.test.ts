// THE PERF REPORT'S WORST FRAMES, PACKED FOR ITS WORKER (client/src/perftimeline.ts `tlPack`,
// client/src/perfshape.ts `shapeWorst`): the timelines go to the worker as typed arrays, and what
// the worker puts on the wire must be exactly what shaping the records' own `_tl` gives — the
// fallback on the game's thread and the worker share the one function, so this covers both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tlPack, tlUnpack, type Mark } from "../../client/src/perftimeline";
import { shapeWorst } from "../../client/src/perfshape";
import type { LoafSplit } from "../../client/src/perfloaf";

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const NAMES = ["preUpdate", "hooks", "render", "depthSort", "gapBusy", "gapIdle", "cells:ground", "amb:gloom:raster", "gap:net", "occCull", "a-name-longer-than-twenty-four-chars"];

function timeline(t0: number): { marks: Mark[]; dropped: number } {
  const marks: Mark[] = [];
  const n = Math.floor(rnd() * 120);
  for (let i = 0; i < n; i++) {
    const a = t0 - 5 + rnd() * 60;
    marks.push([NAMES[Math.floor(rnd() * NAMES.length)], a, a + rnd() * (rnd() < 0.3 ? 0.04 : 12)]);
  }
  return { marks, dropped: rnd() < 0.2 ? Math.floor(rnd() * 40) : 0 };
}

function records(n: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let t = 1000 + rnd() * 5000;
  for (let i = 0; i < n; i++) {
    const total = 20 + rnd() * 200;
    const r: Record<string, unknown> = { total: +total.toFixed(1), sec: { render: 3.2 }, _t0: t, _t1: t + total, pt0: +t.toFixed(1) };
    if (rnd() < 0.85) r._tl = timeline(t);
    if (rnd() < 0.1) delete r._t1;
    out.push(r);
    t += total + rnd() * 400;
  }
  return out;
}

function ringFor(recs: Record<string, unknown>[]): LoafSplit[] {
  return recs
    .filter(() => rnd() < 0.6)
    .map((r) => {
      const a = (r._t0 as number) - 2 + rnd() * 4;
      return { t0: a, t1: a + (r.total as number), pre: +(rnd() * 5).toFixed(1), raf: +(rnd() * 50).toFixed(1), dom: +(rnd() * 3).toFixed(1), by: [["FrameRequestCallback", 12]] } as unknown as LoafSplit;
    });
}

test("tlPack round-trips every timeline exactly: names, the same doubles, dropped, absent ones", () => {
  for (let round = 0; round < 50; round++) {
    const recs = records(Math.floor(rnd() * 30));
    const tls = recs.map((r) => r._tl as { marks: Mark[]; dropped: number } | undefined);
    const p = tlPack(tls);
    assert.equal(p.at[tls.length], tls.reduce((a, tl) => a + (tl ? tl.marks.length : 0), 0));
    tls.forEach((tl, i) => assert.deepEqual(tlUnpack(p, i), tl));
  }
  // The edges: nothing at all, an empty timeline beside an absent one, -0 and huge times.
  assert.equal(tlPack([]).t.length, 0);
  const edge = tlPack([{ marks: [], dropped: 3 }, undefined, { marks: [["x", -0, 1e15], ["x", 0.1 + 0.2, Number.MAX_SAFE_INTEGER]], dropped: 0 }]);
  assert.deepEqual(tlUnpack(edge, 0), { marks: [], dropped: 3 });
  assert.equal(tlUnpack(edge, 1), undefined);
  const back = tlUnpack(edge, 2)!;
  assert.ok(Object.is(back.marks[0][1], -0));
  assert.equal(back.marks[1][1], 0.1 + 0.2);
  assert.deepEqual(edge.names, ["x"]);
});

test("the worker's shaping from the pack is the shaping of the records' own timelines, record for record", () => {
  for (let round = 0; round < 60; round++) {
    const recs = records(1 + Math.floor(rnd() * 24));
    const ring = ringFor(recs);
    const own = shapeWorst(recs, ring, null);
    // As the report hands them over: timelines packed, the records stripped of them, JSON between.
    const p = tlPack(recs.map((r) => r._tl as { marks: Mark[]; dropped: number } | undefined));
    const stripped = recs.map((r) => {
      const o = { ...r };
      delete o._tl;
      return o;
    });
    const viaWorker = shapeWorst(JSON.parse(JSON.stringify(stripped)), JSON.parse(JSON.stringify(ring)), p);
    assert.equal(JSON.stringify(viaWorker), JSON.stringify(own));
    for (const r of viaWorker!) for (const k of ["_t0", "_t1", "_tl"]) assert.ok(!(k in r), `${k} left the client`);
  }
  assert.equal(shapeWorst(null, [], null), null);
});

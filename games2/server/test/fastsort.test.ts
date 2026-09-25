// THE DEPTH SORT FROM THE LAST ORDER (client/src/fastsort.ts): after every
// frame of random edits, the fast sort must leave the list in EXACTLY the order
// Phaser's stable depth sort gives — object for object, not just by depth.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FastDepthSort } from "../../client/src/fastsort";

interface Obj {
  _depth: number;
  id: number;
}

const native = (list: Obj[]): void => {
  list.sort((a, b) => a._depth - b._depth);
};

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Plan {
  /** objects whose depth is rewritten per frame */
  moves: number;
  adds: number;
  removes: number;
  /** probability a frame re-adds an object removed earlier */
  readd: number;
  /** probability a frame moves one object to another index (moveTo) */
  shuffle: number;
  /** depths drawn from a few values, so ties are everywhere */
  ties: boolean;
  frames: number;
}

function run(seed: number, plan: Plan, n0: number): { window: number; merge: number; native: number; noop: number } {
  const rand = rng(seed);
  let nextId = 0;
  const depthOf = (): number => {
    if (plan.ties) return [0, 1, 2, 5, 5.5, 10, Infinity, -Infinity, -0][Math.floor(rand() * 9)];
    return Math.floor(rand() * 20000) / 4;
  };
  const make = (): Obj => ({ _depth: depthOf(), id: nextId++ });
  const list: Obj[] = [];
  for (let i = 0; i < n0; i++) list.push(make());
  const removed: Obj[] = [];
  const fs = new FastDepthSort<Obj>();
  for (let f = 0; f < plan.frames; f++) {
    // edits between two sorts, the way the game makes them
    for (let i = 0; i < plan.moves && list.length; i++) list[Math.floor(rand() * list.length)]._depth = depthOf();
    if (plan.removes && list.length) {
      // destroyBatch / debrisReturn: an in-place filter; Phaser's remove: a splice
      const gone = new Set<Obj>();
      for (let i = 0; i < plan.removes; i++) gone.add(list[Math.floor(rand() * list.length)]);
      if (rand() < 0.5) {
        let w = 0;
        for (let r = 0; r < list.length; r++) if (!gone.has(list[r])) list[w++] = list[r];
        list.length = w;
      } else for (const o of gone) list.splice(list.indexOf(o), 1);
      removed.push(...gone);
    }
    for (let i = 0; i < plan.adds; i++) list.push(make());
    if (removed.length && rand() < plan.readd) {
      // a pooled image back in the list (debrisTake): appended, maybe a new depth
      const o = removed.splice(Math.floor(rand() * removed.length), 1)[0];
      if (!list.includes(o)) {
        if (rand() < 0.5) o._depth = depthOf();
        list.push(o);
      }
    }
    if (list.length > 2 && rand() < plan.shuffle) {
      const [o] = list.splice(Math.floor(rand() * list.length), 1);
      list.splice(Math.floor(rand() * list.length), 0, o);
    }
    const want = list.slice();
    native(want);
    fs.sort(list, native);
    assert.equal(list.length, want.length);
    for (let i = 0; i < list.length; i++)
      if (list[i] !== want[i])
        assert.fail(`seed ${seed} frame ${f}: index ${i} holds #${list[i].id} (${list[i]._depth}), Phaser's sort put #${want[i].id} (${want[i]._depth}) there`);
  }
  return fs.stats;
}

test("a steady frame: a few depths change and nothing else", () => {
  const s = run(1, { moves: 19, adds: 0, removes: 0, readd: 0, shuffle: 0, ties: false, frames: 300 }, 4277);
  assert.ok(s.window + s.merge > 250, `the walk must answer almost every frame (window ${s.window}, merge ${s.merge}, native ${s.native})`);
  assert.equal(s.native, 1, "only the first sort is Phaser's");
});

test("ties everywhere, including Infinity, -Infinity and -0", () => {
  for (let seed = 2; seed < 12; seed++) run(seed, { moves: 30, adds: 3, removes: 3, readd: 0.3, shuffle: 0, ties: true, frames: 120 }, 800);
});

test("a rebuild: hundreds removed by the in-place filter, hundreds appended", () => {
  const s = run(20, { moves: 40, adds: 600, removes: 600, readd: 0.5, shuffle: 0, ties: false, frames: 60 }, 5000);
  assert.ok(s.merge >= 58);
});

test("pooled objects removed and re-added, with and without a new depth", () => {
  for (let seed = 30; seed < 40; seed++) run(seed, { moves: 5, adds: 2, removes: 8, readd: 0.9, shuffle: 0, ties: seed % 2 === 0, frames: 200 }, 300);
});

test("an object moved to another index (moveTo) is still Phaser's order", () => {
  for (let seed = 40; seed < 50; seed++) run(seed, { moves: 3, adds: 1, removes: 1, readd: 0.2, shuffle: 0.7, ties: seed % 2 === 1, frames: 200 }, 200);
});

test("nothing changed: the walk leaves the list alone", () => {
  const s = run(60, { moves: 0, adds: 0, removes: 0, readd: 0, shuffle: 0, ties: false, frames: 50 }, 1000);
  assert.equal(s.noop, 49);
});

/** THE WINDOWS (the steady frame): depths nudged a little, as a walking body's
 *  is, so each dirty object moves a few slots; and some jumps, overlapping
 *  windows, both ends of the list, and ties. */
function nudge(seed: number, n: number, frames: number, moves: number, jump: number, ties: boolean): { window: number; merge: number } {
  const rand = rng(seed);
  const list: Obj[] = [];
  for (let i = 0; i < n; i++) list.push({ _depth: ties ? Math.floor(rand() * 12) : Math.floor(rand() * 4000) / 4, id: i });
  const fs = new FastDepthSort<Obj>();
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < moves; i++) {
      const at = rand() < 0.2 ? (rand() < 0.5 ? 0 : list.length - 1) : Math.floor(rand() * list.length);
      const o = list[at];
      if (rand() < jump) o._depth = ties ? Math.floor(rand() * 12) : Math.floor(rand() * 4000) / 4;
      else o._depth += ties ? Math.floor(rand() * 3) - 1 : (rand() - 0.5) * 4;
    }
    const want = list.slice();
    native(want);
    fs.sort(list, native);
    for (let i = 0; i < list.length; i++)
      if (list[i] !== want[i]) assert.fail(`seed ${seed} frame ${f}: index ${i} holds #${list[i].id} (${list[i]._depth}), Phaser's sort put #${want[i].id} (${want[i]._depth}) there`);
  }
  return fs.stats;
}

test("the steady frame rewrites windows, and they are Phaser's order", () => {
  let windows = 0;
  for (let seed = 70; seed < 90; seed++) windows += nudge(seed, 600, 150, 1 + (seed % 9), seed % 3 === 0 ? 0.3 : 0.02, seed % 2 === 0).window;
  assert.ok(windows > 1500, `the windows must answer the steady frames (${windows})`);
});

test("windows at both ends and a lone object moving the whole length", () => {
  const list: Obj[] = [];
  for (let i = 0; i < 100; i++) list.push({ _depth: i, id: i });
  const fs = new FastDepthSort<Obj>();
  fs.sort(list, native);
  const check = () => {
    const want = list.slice();
    native(want);
    fs.sort(list, native);
    assert.deepEqual(list.map((o) => o.id), want.map((o) => o.id));
  };
  list[0]._depth = 1000; // first to last
  check();
  list[99]._depth = -1; // last to first
  check();
  list[50]._depth = list[51]._depth; // a tie: stays before its twin
  check();
  list[10]._depth = 12.5;
  list[11]._depth = 10.5; // two windows that overlap
  check();
});

test("a NaN depth hands the frame to Phaser's own sort", () => {
  const list: Obj[] = [];
  for (let i = 0; i < 50; i++) list.push({ _depth: i % 7, id: i });
  const fs = new FastDepthSort<Obj>();
  fs.sort(list, native);
  list[10]._depth = NaN;
  const want = list.slice();
  native(want);
  fs.sort(list, native);
  assert.deepEqual(list.map((o) => o.id), want.map((o) => o.id));
  assert.equal(fs.stats.native, 2);
  // and the order after it stays native until the NaN is gone
  list[10]._depth = 3;
  const want2 = list.slice();
  native(want2);
  fs.sort(list, native);
  assert.deepEqual(list.map((o) => o.id), want2.map((o) => o.id));
});

test("an emptied list (scene restart) and a regrown one", () => {
  const fs = new FastDepthSort<Obj>();
  const list: Obj[] = [];
  for (let i = 0; i < 100; i++) list.push({ _depth: (i * 37) % 11, id: i });
  fs.sort(list, native);
  list.length = 0;
  fs.sort(list, native);
  for (let i = 0; i < 100; i++) list.push({ _depth: (i * 13) % 5, id: 100 + i });
  const want = list.slice();
  native(want);
  fs.sort(list, native);
  assert.deepEqual(list.map((o) => o.id), want.map((o) => o.id));
});

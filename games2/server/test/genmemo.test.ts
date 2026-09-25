// THE BOUNDED TWO-GENERATION MEMO (client/src/genmemo.ts) that replaced
// tiles3draw's per-cell WeakMaps: the same answers for the same key object, a
// hard bound on what it holds, and what is still in use surviving a rotation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GenMemo } from "../../client/src/genmemo";

test("a key object reads back its own answer, and a different object with equal contents misses", () => {
  const m = new GenMemo<object, number>(100);
  const a = { col: 1, row: 2 };
  m.set(a, 7);
  assert.equal(m.get(a), 7);
  assert.equal(m.get({ col: 1, row: 2 }), undefined); // identity, like the WeakMap it replaced
});

test("it never holds more than the cap, however many keys go through it", () => {
  const cap = 64;
  const m = new GenMemo<object, number>(cap);
  for (let i = 0; i < 10_000; i++) {
    m.set({ i }, i);
    assert.ok(m.size <= cap, `size ${m.size} at insert ${i}`);
  }
  assert.ok(m.rotations > 100);
});

test("an entry still in use survives the rotation; one nobody asks for is dropped a generation later", () => {
  const m = new GenMemo<object, string>(8); // the young generation rotates at 4
  const kept = { k: "kept" };
  const idle = { k: "idle" };
  m.set(kept, "K");
  m.set(idle, "I");
  for (let i = 0; i < 2; i++) m.set({ i }, "x"); // young reaches 4: rotates, both now old
  assert.equal(m.rotations, 1);
  assert.equal(m.get(kept), "K"); // an old hit: promoted into the young generation
  for (let i = 0; i < 3; i++) m.set({ j: i }, "y"); // young reaches 4 again: the old is dropped
  assert.equal(m.rotations, 2);
  assert.equal(m.get(kept), "K");
  assert.equal(m.get(idle), undefined);
});

test("clear drops everything", () => {
  const m = new GenMemo<object, number>(10);
  const a = {};
  m.set(a, 1);
  m.clear();
  assert.equal(m.get(a), undefined);
  assert.equal(m.size, 0);
});

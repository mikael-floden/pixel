import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { JsonPlayerStore, MemoryPlayerStore } from "../src/store.js";

test("JsonPlayerStore round-trips a record and persists across instances", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ml-store-")), "players.json");
  const rec = { character: "sk/char_00", name: "Ari", x: 123.5, y: 800 };

  const a = new JsonPlayerStore(file);
  assert.equal(a.load("tok-1"), undefined);
  a.save("tok-1", rec);
  assert.deepEqual(a.load("tok-1"), rec);

  // A fresh instance reads the file written by the first.
  const b = new JsonPlayerStore(file);
  assert.deepEqual(b.load("tok-1"), rec);
  assert.equal(b.load("unknown"), undefined);
});

test("empty token is ignored", () => {
  const s = new MemoryPlayerStore();
  s.save("", { character: "x", name: "y", x: 0, y: 0 });
  assert.equal(s.load(""), undefined);
});

test("records never alias live objects (deep-copied at both boundaries)", () => {
  // The review repro: a live Player.inv aliased the persisted record, so
  // mid-play slot.n++ mutated the "saved" state and another leaver's save
  // then persisted the half-live blend.
  const file = join(mkdtempSync(join(tmpdir(), "ml-store-")), "players.json");
  const s = new JsonPlayerStore(file);
  const rec = { character: "c", name: "n", x: 1, y: 2, inv: [{ item: "apple", n: 3 }] };
  s.save("tok", rec);
  rec.inv[0].n = 99; // mutate the object we handed in
  assert.equal(s.load("tok")!.inv![0].n, 3, "save() detached from the caller's object");
  const a = s.load("tok")!;
  a.inv![0].n = 50; // mutate a loaded copy
  assert.equal(s.load("tok")!.inv![0].n, 3, "load() hands out fresh copies");

  const m = new MemoryPlayerStore();
  m.save("tok", rec);
  rec.inv[0].n = 7;
  assert.equal(m.load("tok")!.inv![0].n, 99, "memory store detached too");
});

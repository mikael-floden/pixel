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

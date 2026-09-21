// A DEBUG OVERLAY DOES NOT SURVIVE A RELOAD (maintainer 2026-09-21). All four
// of them — the game's zone borders, spawn areas and aggro radii, and
// ambient's zone lines — were remembered per device, and remembered is how one
// ruins a session: he played with the ambient zones on, then REINSTALLED THE
// APP AND CLEARED HIS CACHE, and it came back (site data outlives both). Every
// screenshot he sent for half an hour was his world under green and salmon
// zigzags and zone-name labels, over terrain that was still streaming — "THEY
// LOOK LIKE A GAME FROM 30 YEARS AGO", "WHO DESTROYED THE GAME". Nothing was
// destroyed and nothing was his fault: a switch he flicked once was still on
// days later with no way to know it. They start OFF on every load now, they
// are not written down, and each clears the key an older build left behind.
// This reads the client sources, so it holds whatever the bundler ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const scene = readFileSync(join(HERE, "..", "..", "client", "src", "scenes", "WorldScene.ts"), "utf8");
const ambient = readFileSync(join(HERE, "..", "..", "ambient", "runtime", "zonelines.ts"), "utf8");

/** The keys, and the file that owns each. */
const OVERLAYS: { key: string; src: string; what: string }[] = [
  { key: "ml-zone-lines", src: scene, what: "the game's zone borders" },
  { key: "ml-spawn-areas", src: scene, what: "the spawn areas" },
  { key: "ml-aggro-radius", src: scene, what: "the aggro radii" },
  { key: "ml-ambient-zones", src: ambient, what: "ambient's zone lines" },
];

test("no debug overlay reads its switch back from storage — each starts off on every load", () => {
  for (const { key, src, what } of OVERLAYS) {
    const reads = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && l.includes(key) && /getItem|localStorage\.getItem/.test(l));
    assert.deepEqual(reads, [], `${what} (${key}) reads its state back: ${reads.join(" | ")}`);
  }
});

test("...and none of them writes one down, so a session cannot inherit one", () => {
  for (const { key, src, what } of OVERLAYS) {
    const writes = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && l.includes(key) && /setItem/.test(l));
    assert.deepEqual(writes, [], `${what} (${key}) is remembered: ${writes.join(" | ")}`);
  }
});

test("...and each clears the key an older build left on the device", () => {
  for (const { key, src, what } of OVERLAYS) {
    assert.ok(
      /removeItem/.test(src) && src.includes(key),
      `${what} (${key}) must clear its stored key so a device carrying one is freed by its next load`,
    );
  }
});

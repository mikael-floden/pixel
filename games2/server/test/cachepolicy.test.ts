// The one-year grant is UNRECALLABLE, so it gets its own test file.
//
// A browser that has cached a URL as `immutable` for a year cannot be told to
// forget it — no deploy, no purge, no F5. Every case below is therefore about
// one question: can this rule ever freeze bytes that are allowed to change?
//
// The headline case is the FOURTH one. `setCacheHeaders` is shared by the
// client bundle and the /assets/<domain> art mounts, and the art agents
// repaint tiles IN PLACE (same path, new pixels). So a policy that decided by
// filename shape alone would freeze a repainted tile for a year the first time
// an art file was named `foo-a1b2c3d4.webp`. The directory scope is what makes
// that impossible rather than merely unlikely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMMUTABLE, REVALIDATE, cacheControlFor } from "../src/cachepolicy.js";

const GAME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT_DIST = join(GAME_ROOT, "client", "dist");
const BUNDLE_DIR = join(CLIENT_DIST, "assets");
const SHA = "88bd42ed3";

const cc = (filePath: string, queryV?: unknown, gitSha = SHA) =>
  cacheControlFor({ filePath, bundleDir: BUNDLE_DIR, gitSha, queryV });

test("hashed bundle files are immutable — EVERY type rollup emits, not just js/css", () => {
  // The 2026-08-15 fix: these five extensions are 532 of the 535 emitted files.
  for (const name of [
    "index-BhE6GoEV.js",
    "style-A1b2C3d4.css",
    "grass__take01-THfxJyrg.ogg",
    "adventure-76AJUTK9.m4a",
    "title-DmHrn4Nx.mp3",
    "step-Ab3d_f-9.wav",
    "sprite-Zz00Yy11.webp",
  ]) {
    assert.equal(cc(join(BUNDLE_DIR, name)), IMMUTABLE, name);
  }
});

test("an unhashed file inside the bundle dir stays revalidated", () => {
  // A future build step dropping a fixed-name file there must not inherit a
  // grant it cannot honour.
  for (const name of ["manifest.json", "worker.js", "logo.webp", "a-short.js"]) {
    assert.equal(cc(join(BUNDLE_DIR, name)), REVALIDATE, name);
  }
});

test("ART with a hash-SHAPED name is never frozen — it is edited in place", () => {
  // THE CACHE-BUG REGRESSION. Each of these would be caught by a filename-only
  // rule and served stale for a year after the owning agent repaints it.
  const ART = join(GAME_ROOT, "..");
  for (const rel of [
    ["tiles2", "grass_x_2", "tile-a1b2c3d4.webp"],
    ["characters2", "humans", "hero", "walk-DmHrn4Nx.webp"],
    ["monsters", "saber_tooth", "attack-76AJUTK9.webp"],
    ["scenery", "trees", "oak-THfxJyrg.webp"],
    ["sounds", "footsteps", "grass-Ab3d_f-9.ogg"],
  ]) {
    assert.equal(cc(join(ART, ...rel)), REVALIDATE, rel.join("/"));
  }
});

test("a sibling directory cannot pass as the bundle dir", () => {
  // Guards the trailing-separator detail in isHashedBundleFile.
  assert.equal(cc(join(CLIENT_DIST, "assetsX", "index-BhE6GoEV.js")), REVALIDATE);
  assert.equal(cc(join(CLIENT_DIST, "assets-old", "index-BhE6GoEV.js")), REVALIDATE);
  assert.equal(cc(join(CLIENT_DIST, "index-BhE6GoEV.js")), REVALIDATE);
});

test("the ?v art grant is unchanged: matching sha only, real deploys only", () => {
  const tile = join(GAME_ROOT, "..", "tiles2", "grass_x_2", "0.webp");
  assert.equal(cc(tile, SHA), IMMUTABLE, "?v matches this instance");
  assert.equal(cc(tile, "deadbeef"), REVALIDATE, "rollout mismatch degrades, never freezes");
  assert.equal(cc(tile, undefined), REVALIDATE, "unstamped art revalidates");
  assert.equal(cc(tile, "dev", "dev"), REVALIDATE, "a dev build never grants a year");
  assert.equal(cc(tile, "", ""), REVALIDATE, "an unset GIT_SHA never grants a year");
});

test("the ?h grant is verified against the SERVED BYTES, never against the index or the URL alone", () => {
  const tile = join(GAME_ROOT, "..", "tiles2", "grass_x_2", "0.webp");
  const real = "0123456789abcdef"; // what the file hashes to, per the server's own hashing
  const at = (queryH: unknown, fileHash: (() => string | null) | undefined, queryV?: unknown, gitSha = SHA) =>
    cacheControlFor({ filePath: tile, bundleDir: BUNDLE_DIR, gitSha, queryV, queryH, fileHash });
  assert.equal(at(real, () => real), IMMUTABLE, "hash matches the bytes → a year");
  assert.equal(at("fedcba9876543210", () => real), REVALIDATE, "a stale index's hash never freezes new bytes");
  assert.equal(at(real, () => null), REVALIDATE, "unhashable file → nothing granted");
  assert.equal(at(real, undefined), REVALIDATE, "no hasher wired → nothing granted");
  assert.equal(at("0123456789ABCDEF", () => real), REVALIDATE, "malformed (upper-case) hash → no lookup");
  assert.equal(at("0123", () => real), REVALIDATE, "malformed (short) hash → no lookup");
  assert.equal(at(["a", "b"], () => real), REVALIDATE, "non-string query → no lookup");
  assert.equal(at(real, () => real, "deadbeef", "dev"), IMMUTABLE, "?h stands on its own, even on a dev sha");
  assert.equal(at("fedcba9876543210", () => real, SHA), IMMUTABLE, "a wrong ?h does not revoke a matching ?v");
  let hashed = 0;
  assert.equal(at(undefined, () => (hashed++, real)), REVALIDATE, "no ?h → the file is not hashed at all");
  assert.equal(hashed, 0, "hashing is lazy: only a well-formed ?h pays for it");
});

test("index.html is never frozen — it names the hashed bundles", () => {
  assert.equal(cc(join(CLIENT_DIST, "index.html")), REVALIDATE);
  assert.equal(cc(join(CLIENT_DIST, "sw.js")), REVALIDATE);
  assert.equal(cc(join(CLIENT_DIST, "characters.json")), REVALIDATE);
});

// The tests above reason about paths. This one checks the assumption they rest
// on against the REAL build: that dist/assets contains nothing but hashed
// rollup output. Skipped where the tree is absent (CI's sparse checkout).
test("every file in the real dist/assets is hashed, so the grant is total", (t) => {
  if (!existsSync(BUNDLE_DIR)) return t.skip("no client/dist — run npm run build:client");
  const files = readdirSync(BUNDLE_DIR);
  const unhashed = files.filter((f) => cc(join(BUNDLE_DIR, f)) !== IMMUTABLE);
  assert.deepEqual(unhashed, [], `unhashed files in dist/assets would silently stay no-cache`);
  assert.ok(files.length > 0, "dist/assets is empty");
});

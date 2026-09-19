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
    ["tiles", "plates", "grass", "clean-a1b2c3d4.webp"],
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

test("the ?v grant for NON-ART: matching sha only, real deploys only", () => {
  const pub = join(CLIENT_DIST, "logo.webp"); // client/public — the art lane never publishes it
  assert.equal(cc(pub, SHA), IMMUTABLE, "?v matches this instance");
  assert.equal(cc(pub, "deadbeef"), REVALIDATE, "rollout mismatch degrades, never freezes");
  assert.equal(cc(pub, undefined), REVALIDATE, "unstamped revalidates");
  assert.equal(cc(pub, "dev", "dev"), REVALIDATE, "a dev build never grants a year");
  assert.equal(cc(pub, "", ""), REVALIDATE, "an unset GIT_SHA never grants a year");
});

test("ART IS NEVER FROZEN BY ?v — THE ART LANE'S WHOLE SAFETY ARGUMENT", () => {
  // `?v=<sha>` promises "for this GIT_SHA these bytes are fixed". The art lane
  // republishes art onto a RUNNING instance, so the pixels move while GIT_SHA
  // stands still and that promise becomes one URL naming two byte-sets for a
  // year — the unrecallable bug. Art earns its year through ?h alone, where the
  // hash IS the bytes. Measured live before the change: /assets/items/
  // abalone_shell_half/sprite.webp?v=b18bd137... answered
  // `public, max-age=31536000, immutable`.
  const art = join(GAME_ROOT, "..", "tiles", "plates", "grass", "clean.webp");
  const asArt = (queryV?: unknown, gitSha = SHA) =>
    cacheControlFor({ filePath: art, bundleDir: BUNDLE_DIR, gitSha, queryV, isArt: true });
  assert.equal(asArt(SHA), REVALIDATE, "a matching ?v no longer freezes art");
  assert.equal(asArt("deadbeef"), REVALIDATE);
  assert.equal(asArt(undefined), REVALIDATE);
  // ...and the SAME path with isArt unset keeps the old answer, so the flag is
  // what decides and nothing else drifted.
  assert.equal(cc(art, SHA), IMMUTABLE, "the rule itself is unchanged; only the caller's flag revokes it");
});

test("?h still grants a year to ART — that grant is arithmetic, not a promise", () => {
  const art = join(GAME_ROOT, "..", "scenery", "trees", "oak.webp");
  const real = "0123456789abcdef";
  const asArt = (queryH: unknown, fileHash: () => string | null, queryV?: unknown) =>
    cacheControlFor({ filePath: art, bundleDir: BUNDLE_DIR, gitSha: SHA, queryV, queryH, fileHash, isArt: true });
  assert.equal(asArt(real, () => real), IMMUTABLE, "hash matches the served bytes → a year, art or not");
  assert.equal(asArt("fedcba9876543210", () => real), REVALIDATE, "a stale hash never freezes new pixels");
  assert.equal(asArt(real, () => real, SHA), IMMUTABLE, "?v being present neither helps nor hurts");
  assert.equal(asArt("fedcba9876543210", () => real, SHA), REVALIDATE, "and a wrong ?h cannot fall back on ?v for art");
});

test("a hashed BUNDLE file keeps its grant even if a caller mislabels it art", () => {
  // Rule (1) is tested first and is about a directory rollup owns, so an
  // isArt=true that reached the bundle dir by mistake cannot cost the bundle
  // its cache. Belt: the two are different mounts and cannot swap.
  assert.equal(
    cacheControlFor({ filePath: join(BUNDLE_DIR, "index-BhE6GoEV.js"), bundleDir: BUNDLE_DIR, gitSha: SHA, queryV: SHA, isArt: true }),
    IMMUTABLE,
  );
});

test("the ?h grant is verified against the SERVED BYTES, never against the index or the URL alone", () => {
  const tile = join(GAME_ROOT, "..", "tiles", "plates", "grass", "clean.webp");
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_HASH_RE, assetHash, hashBytes, resetAssetHashMemo } from "../src/assethash.js";

const GAME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha16 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);

test("assetHash is sha256-16 of the bytes, memoised, and re-hashes when the file changes", () => {
  resetAssetHashMemo();
  const dir = mkdtempSync(join(tmpdir(), "assethash-"));
  const f = join(dir, "a.webp");
  writeFileSync(f, "first");
  assert.equal(assetHash(f), sha16("first"));
  assert.ok(ASSET_HASH_RE.test(assetHash(f)!));
  assert.equal(hashBytes(Buffer.from("first")), sha16("first"));
  // Same size, later mtime: a rewrite the memo must not hide.
  writeFileSync(f, "third");
  utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(assetHash(f), sha16("third"), "an edited file re-hashes");
  assert.equal(assetHash(join(dir, "missing.webp")), null, "missing → null, never a grant");
  assert.equal(assetHash(dir), null, "a directory → null");
});

test("build-asset-index.mjs: deterministic, every file, sorted, sha256-16, never itself", () => {
  const root = mkdtempSync(join(tmpdir(), "assetindex-"));
  mkdirSync(join(root, "monsters", "frog"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "monsters", "frog", "walk.webp"), "frog-walk");
  writeFileSync(join(root, "monsters", "roster.json"), "{}");
  writeFileSync(join(root, "a.txt"), "top");
  writeFileSync(join(root, ".git", "HEAD"), "ref");
  const out = join(root, "asset-index.json");
  const run = () => {
    execFileSync("node", [join(GAME_ROOT, "scripts", "build-asset-index.mjs"), "--root", root, "--out", out], { stdio: "pipe" });
    return readFileSync(out, "utf8");
  };
  const a = run();
  const doc = JSON.parse(a) as { schema: string; algo: string; files: Record<string, string> };
  assert.equal(doc.schema, "nangijala-asset-index@1");
  assert.equal(doc.algo, "sha256-16");
  assert.deepEqual(Object.keys(doc.files), ["a.txt", "monsters/frog/walk.webp", "monsters/roster.json"], "sorted, dotdirs skipped, index itself skipped");
  assert.equal(doc.files["monsters/frog/walk.webp"], sha16("frog-walk"));
  assert.equal(doc.files["a.txt"], sha16("top"));
  assert.equal(run(), a, "byte-identical on a second run, with the index now present in the tree");
});

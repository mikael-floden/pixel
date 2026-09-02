// THE ASSET INDEX — `nangijala-asset-index@1`: the content hash of every file
// under an assets root, so the client can stamp art with `?h=<hash>` and an
// unchanged file keeps its URL across deploys (client/src/assetver.ts; the
// server grants the cache only after verifying the hash against the bytes it
// serves — server/src/cachepolicy.ts).
//
//   node scripts/build-asset-index.mjs --root <assets root> --out <file>
//
// Runs in the Dockerfile's build stage against /assets AFTER the curated root
// is complete (ship-tiles3 included) — the index must describe exactly the
// files the runtime serves. Deterministic: sorted paths, sha256 first 16 hex.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = resolve(arg("--root") ?? process.env.ASSETS_ROOT ?? ".");
const out = resolve(arg("--out") ?? join(root, "asset-index.json"));
const t0 = performance.now();
const files = {};
let bytes = 0;
const walk = (dir) => {
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (ent.name.startsWith(".")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.isFile()) {
      if (p === out) continue; // never index the index
      const buf = readFileSync(p);
      bytes += buf.length;
      files[relative(root, p).split(sep).join("/")] = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    }
  }
};
walk(root);
const doc = { schema: "nangijala-asset-index@1", algo: "sha256-16", files: Object.fromEntries(Object.entries(files).sort()) };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc));
const n = Object.keys(files).length;
console.log(`[asset-index] ${n} files, ${(bytes / 1e6).toFixed(1)} MB hashed in ${Math.round(performance.now() - t0)} ms → ${out} (${(statSync(out).size / 1e6).toFixed(2)} MB)`);

// Run the manifest builders — but only when their INPUTS have actually
// changed.
//
// WHY: `npm test` is `npm run manifest && …`, so every test run, every
// `npm run dev` and every image build re-derived every manifest from
// scratch. Measured 1.8s, of which build-monsters-manifest.mjs is ~1.2s
// because it pngjs-DECODES 384 monster strips (3,608 PNGs, 15 MB) to measure
// shadow anchors. The art changes a few times a day; the manifests were
// rebuilt hundreds of times a day.
//
// HOW: fingerprint every input file (path + size + mtime) plus the builder
// sources themselves, and skip when the fingerprint matches the last run AND
// every output is present. Changing a builder therefore invalidates too.
//
// STALENESS RISK, stated plainly: mtime+size is the standard cheap fingerprint
// but it is not a content hash. A file restored with a preserved mtime and an
// identical size would not be noticed. That is why the cache lives in
// node_modules/.cache (never committed, never shipped): a fresh clone, CI and
// the Docker build all start cold and rebuild from scratch, so the risk is
// confined to one developer machine and is undone by `npm run manifest:force`.
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, "..");
// Art domains live at the repo root by default; ASSETS_ROOT overrides it
// (Docker bakes them at /assets) — mirror what the builders themselves do.
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..");

const BUILDERS = ["build-manifest.mjs", "build-worlds.mjs", "build-monsters-manifest.mjs", "build-npcs-manifest.mjs"];
// Modules the builders IMPORT. A builder's own mtime is not enough: when the
// PNG/WebP decode moved out of build-manifest.mjs into imagelib.mjs
// (f4912fa89), editing the decode stopped invalidating this cache — proven by
// injecting a 3px alpha-sampling bug, building, restoring the correct file, and
// watching `npm run manifest` report "up to date" over a characters.json that
// still carried the wrong foot anchors. That is the WRONG-VALUES failure, not a
// crash: a throwing builder writes no cache and self-heals, but a silently
// wrong one is committable — and monsters.json IS committed.
// Listed explicitly rather than globbed: scripts/ holds ~58 files, almost all
// unrelated verify/debug tools, and the gitignored scripts/_tmp-*.mjs probes
// would thrash the cache on every session.
const BUILDER_DEPS = ["imagelib.mjs"];
const OUTPUTS = ["characters.json", "worlds.json", "monsters.json", "npcs.json"].map((f) =>
  join(GAME_ROOT, "client", "public", f),
);
// Input trees, in the same terms the builders read them.
const INPUTS = [
  join(ASSETS_ROOT, "characters2"),
  join(ASSETS_ROOT, "maps2", "worlds"),
  join(ASSETS_ROOT, "monsters"),
  ...BUILDERS.map((b) => join(SCRIPT_DIR, b)),
  ...BUILDER_DEPS.map((b) => join(SCRIPT_DIR, b)),
  // build-manifest merges the maintainer's hand-drawn swim waterlines from
  // here, so editing one must rebuild too (same hole, different file).
  join(GAME_ROOT, "data"),
];

const CACHE = join(GAME_ROOT, "node_modules", ".cache", "manifest-fingerprint.json");
const force = process.argv.includes("--force") || process.env.MANIFEST_FORCE === "1";

/** path + size + mtime of every file under `p`, hashed. Order-stable. */
function fingerprint(paths) {
  const h = createHash("sha1");
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      h.update(`missing:${p}\n`);
      return;
    }
    if (st.isDirectory()) {
      for (const n of readdirSync(p).sort()) {
        if (n === "node_modules" || n.startsWith(".")) continue;
        walk(join(p, n));
      }
    } else {
      h.update(`${p}:${st.size}:${st.mtimeMs}\n`);
    }
  };
  for (const p of paths) walk(p);
  return h.digest("hex");
}

const t0 = Date.now();
const fp = fingerprint(INPUTS);
const outputsPresent = OUTPUTS.every((f) => existsSync(f));
let cached = null;
try {
  cached = JSON.parse(readFileSync(CACHE, "utf8")).fingerprint;
} catch {}

if (!force && outputsPresent && cached === fp) {
  console.log(`[manifest] up to date (inputs unchanged, ${Date.now() - t0}ms)`);
  process.exit(0);
}

for (const b of BUILDERS) execFileSync(process.execPath, [join(SCRIPT_DIR, b)], { stdio: "inherit" });

// Re-fingerprint AFTER building: a builder that writes into an input tree
// would otherwise cache a value that never matches again.
try {
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify({ fingerprint: fingerprint(INPUTS), at: new Date().toISOString() }));
} catch {
  // A read-only or absent node_modules just means no caching — never fatal.
}
console.log(`[manifest] rebuilt in ${Date.now() - t0}ms`);

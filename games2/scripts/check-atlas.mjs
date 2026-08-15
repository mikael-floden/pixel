// check-atlas — is every committed tile atlas still TRUE of the tiles on disk?
//
// The atlases (client/public/atlases, built by build-atlas.py) are committed
// and content-addressed: each index carries a digest over the world's tile
// list AND every tile's bytes. Deploys never rebuild them — they only run this
// check, which recomputes that digest and compares.
//
// --prune is the guard that keeps a stale atlas HARMLESS rather than wrong:
// on mismatch the atlas (index + sheets) is DELETED, the client's index fetch
// 404s, and it falls back to loading individual tiles — slower, never wrong
// pixels, never a red pipeline. The failure mode of "tiles2 regenerated a tile
// in place and nobody re-ran npm run atlas" is a log line and a slow world
// boot, not old art on screen.
//
// Runs everywhere `npm run manifest` runs, so it must behave under the CI test
// job's SPARSE checkout (no tiles2 art): a tile file that is ABSENT means
// "cannot verify here" and is skipped silently; only a file that is PRESENT
// with different bytes is stale. The strict full-tree run is the Docker image
// build (ASSETS_ROOT=/assets), where absence really means missing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const GAME_ROOT = join(SCRIPT_DIR, "..");
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(GAME_ROOT, "..");
const ATLAS_DIR = join(GAME_ROOT, "client", "public", "atlases");
const PRUNE = process.argv.includes("--prune");
const QUIET = process.argv.includes("--quiet");
const STRICT = process.argv.includes("--strict"); // image build: absence = stale
// --ship: keep ONLY the atlases for worlds this image publishes. Dev-world
// atlases are ~16 MB of sheets for maps that are staging content since
// 2026-08-15 — an admin who joins one streams its tiles from the repo, so a
// copy in the image is pure weight. client/public is copied wholesale by the
// Dockerfile, which is how they got in.
const SHIP = process.argv.includes("--ship");

const log = (m) => !QUIET && console.log(m);

if (!existsSync(ATLAS_DIR)) {
  log("[atlas-check] no atlases directory — nothing to check");
  process.exit(0);
}

let shipWorlds = null;
if (SHIP) {
  try {
    const pol = JSON.parse(readFileSync(join(GAME_ROOT, "config", "publish.json"), "utf8"));
    shipWorlds = new Set(pol.userWorlds ?? pol.worlds ?? []);
  } catch {
    console.warn("[atlas-check] --ship: no readable publish policy — keeping every atlas");
  }
}

let ok = 0, stale = 0, unverifiable = 0, dropped = 0;
for (const f of readdirSync(ATLAS_DIR).filter((n) => n.endsWith(".json")).sort()) {
  const name = f.replace(/\.json$/, "");
  const prune = (why) => {
    stale++;
    console.warn(`[atlas-check] ${name}: STALE — ${why}${PRUNE ? " — pruning (client falls back to per-file tiles)" : ""}`);
    if (PRUNE) {
      for (const s of readdirSync(ATLAS_DIR)) {
        if (s === f || (s.startsWith(`${name}.`) && s.endsWith(".webp"))) unlinkSync(join(ATLAS_DIR, s));
      }
    }
  };

  if (shipWorlds && !shipWorlds.has(name)) {
    for (const f2 of readdirSync(ATLAS_DIR))
      if (f2 === f || (f2.startsWith(`${name}.`) && f2.endsWith(".webp"))) unlinkSync(join(ATLAS_DIR, f2));
    dropped++;
    continue;
  }

  let idx;
  try {
    idx = JSON.parse(readFileSync(join(ATLAS_DIR, f), "utf8"));
  } catch {
    prune("unreadable index");
    continue;
  }
  const wj = join(ASSETS_ROOT, "maps2", "worlds", name, "world.json");
  if (!existsSync(wj)) {
    // Sparse tree without maps2? Then nothing is verifiable at all. With
    // maps2 present, a missing world means the atlas is orphaned.
    if (!existsSync(join(ASSETS_ROOT, "maps2", "worlds"))) {
      unverifiable++;
      continue;
    }
    prune("its world no longer exists");
    continue;
  }
  const paths = [...new Set((JSON.parse(readFileSync(wj, "utf8")).paths ?? []).filter((p) => typeof p === "string"))].sort();
  const absent = paths.filter((p) => !existsSync(join(ASSETS_ROOT, p)));
  if (absent.length && !STRICT) {
    // Sparse checkout: the art simply is not here. Cannot verify, must not prune.
    unverifiable++;
    continue;
  }
  if (absent.length) {
    prune(`${absent.length} referenced tiles missing from the curated root (e.g. ${absent[0]})`);
    continue;
  }
  const h = createHash("sha256");
  for (const p of paths) {
    h.update(p);
    h.update(Buffer.from([0]));
    h.update(createHash("sha256").update(readFileSync(join(ASSETS_ROOT, p))).digest());
  }
  const digest = h.digest("hex").slice(0, 16);
  if (digest !== idx.tilesetDigest) {
    prune(`tileset digest ${digest} != atlas ${idx.tilesetDigest} (a tile changed or the world's set did) — run npm run atlas`);
    continue;
  }
  const missingSheet = (idx.sheets ?? []).find((s) => !existsSync(join(ATLAS_DIR, s)));
  if (missingSheet) {
    prune(`sheet ${missingSheet} missing`);
    continue;
  }
  ok++;
}

log(`[atlas-check] ${ok} current, ${stale} stale${PRUNE && stale ? " (pruned)" : ""}, ${unverifiable} unverifiable here${dropped ? `, ${dropped} non-shipped atlas(es) removed` : ""}`);
// Stale is never fatal: pruning already made it safe, and failing here would
// let an in-place tiles2 regeneration turn the whole pipeline red — the exact
// failure mode the sparse-checkout incident taught us to design out.

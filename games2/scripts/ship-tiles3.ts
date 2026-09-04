// SHIP THE TILES3 ART CLOSURE of every published maps2/worlds3 world.
//
//   npx tsx scripts/ship-tiles3.ts --root <repo tree> [--out <assets root>] [--check]
//
// Runs in the Dockerfile's BUILD stage (the curate stage has no TypeScript):
// --root is /full (the whole repo the curate stage was handed), --out is
// /assets (the curated root the image serves), and the runtime stage copies
// /assets/tiles from here. Worlds come from config/publish.json `userWorlds`;
// only names that exist under maps2/worlds3 have a tiles3 closure.
//
// --check fails on a file the resolver names but the tree lacks — the one
// error that would otherwise become a silent 404 in production (shipset's
// --check rule, applied to this closure). Always creates <out>/tiles, so the
// runtime COPY has a source even when no worlds3 world is published.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tiles3ArtClosure } from "./tiles3closure";

const GAME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const root = resolve(arg("--root") ?? join(GAME_ROOT, ".."));
const out = arg("--out") ? resolve(arg("--out")!) : null;
const check = argv.includes("--check");

const policy = JSON.parse(readFileSync(join(GAME_ROOT, "config", "publish.json"), "utf8")) as { userWorlds?: string[] };
const worlds = (policy.userWorlds ?? []).filter((n) => existsSync(join(root, "maps2", "worlds3", n, "world.json")));
if (out) mkdirSync(join(out, "tiles"), { recursive: true });
if (!worlds.length) {
  console.log(`[ship-tiles3] no published maps2/worlds3 world under ${root} — nothing to ship`);
  process.exit(0);
}
if (!existsSync(join(root, "tiles", "ground_types.json"))) {
  console.error(`[ship-tiles3] tiles/ is not under ${root} — cannot resolve ${worlds.join(", ")}`);
  process.exit(check ? 1 : 0);
}
const t0 = performance.now();
const c = tiles3ArtClosure(root, worlds);
const ms = Math.round(performance.now() - t0);
for (const w of c.worlds)
  console.log(`[ship-tiles3] ${w.name}: ${w.width}x${w.height}, ${w.cells} cells, ${w.boundaries} boundaries, ${w.decks} deck cells, ${w.failures} resolver failures`);
console.log(`[ship-tiles3] closure: ${c.art.length} art files (${(c.bytes / 1e6).toFixed(2)} MB) + ${c.docs.length} documents, resolved in ${ms} ms`);
for (const m of c.warnings.slice(0, 5)) console.warn(`[ship-tiles3] ${m}`);
if (c.missing.length) {
  console.error(`[ship-tiles3] ${c.missing.length} file(s) the resolver names are MISSING under ${root}:`);
  for (const m of c.missing.slice(0, 20)) console.error(`  ${m}`);
  if (check) process.exit(1);
}
/* ART THE LIVE CHANNEL MAY NAME AFTER THIS BUILD.
 *
 * The closure above is exact for the world as it stands at BUILD time, and that is
 * precisely the problem: base_tile_sets.json lives in live/tuning and is re-read from
 * GitHub at RUNTIME, without a deploy - that is what the live channel is for. The
 * moment the maintainer re-picks a base tile set, the running game asks for member art
 * that this build never shipped, gets a 404, and the cell falls back. A boundary then
 * has nothing to compose from and draws as a raw diamond edge.
 *
 * Measured in production 2026-09-03, resolving what the running game actually requests:
 *   tiles/tops/light_beach/.../post/tile_10.527461a9.webp   200
 *   tiles/base_candidates/grass/grass__to__lava__a24_s6.webp  404   <- exists in repo
 * and the maintainer's screenshot shows exactly that: grass meeting sand as a hard
 * zigzag with no transition.
 *
 * So the pools a live document can pick FROM are shipped whole, rather than the members
 * it happened to name at build time. Deriving a closure from a document that changes
 * after the build is the bug. The cost is small because these are the pools, not the
 * whole domain. MEASURED on a real run: the shipped tree goes from 794 files / 0.6 MB
 * to 11,268 / 21.9 MB, against a 400 MB domain. (`du` reports 64 MB for it because the
 * mean file is 1,945 bytes and every one rounds up to a 4 KB block - the bytes that
 * travel are 21.9 MB.) Plates stay closure-only: a plate is addressed by review key and
 * the closure resolves those exactly, so shipping all 3,700 (16 MB) would buy nothing.
 */
function underRoot(rel: string, keep: (p: string) => boolean): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (keep(f)) out.push(f.slice(root.length + 1));
    }
  };
  walk(abs);
  return out;
}
const livePools = [
  ...underRoot("tiles/base_candidates", (f) => f.endsWith(".webp")),
  ...underRoot("tiles/tops", (f) => f.endsWith(".webp") && f.includes(`${"/"}post${"/"}`)),
];
console.log(`[ship-tiles3] live-tuning pools: ${livePools.length} extra files (base_candidates + tops/post)`);

if (out) {
  let copied = 0;
  for (const p of [...c.docs, ...c.art, ...livePools]) {
    const src = join(root, p);
    if (!existsSync(src)) continue;
    const dst = join(out, p);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied++;
  }
  console.log(`[ship-tiles3] copied ${copied} files into ${out}`);
}

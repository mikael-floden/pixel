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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
if (out) {
  let copied = 0;
  for (const p of [...c.docs, ...c.art]) {
    const src = join(root, p);
    if (!existsSync(src)) continue;
    const dst = join(out, p);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    copied++;
  }
  console.log(`[ship-tiles3] copied ${copied} files into ${out}`);
}

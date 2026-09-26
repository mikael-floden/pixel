import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tiles3ArtClosure } from "../../scripts/tiles3closure";

const GAME_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = join(GAME_ROOT, "..");

test("the tiles3 art closure of every published worlds3 world resolves completely, and stays a closure", () => {
  const policy = JSON.parse(readFileSync(join(GAME_ROOT, "config", "publish.json"), "utf8")) as { userWorlds?: string[] };
  const worlds = (policy.userWorlds ?? []).filter((n) => existsSync(join(REPO, "maps2", "worlds3", n, "world.json")));
  // The deploy's test job sparse-checks-out maps2/worlds only; the image builds
  // from the full tree and ship-tiles3 --check guards it there.
  if (!worlds.length) return test.skip("no published maps2/worlds3 world checked out");
  if (!existsSync(join(REPO, "tiles", "ground_types.json"))) return test.skip("tiles/ not checked out");
  const c = tiles3ArtClosure(REPO, worlds);
  assert.deepEqual(c.missing, [], "a named-but-missing file is a production 404");
  for (const w of c.worlds) {
    assert.equal(w.failures, 0, `${w.name}: the resolver threw`);
    /* VOID CELLS ARE NOT UNRESOLVED CELLS. maps2 voids ground on purpose (the
     * mountain's back, 2026-09-05: 3,864 cells of the_game), and a void cell
     * resolves to null, draws nothing and names no art — it is not a failure
     * and not a hole. The whole grid must still be accounted for. */
    assert.ok(w.cells > 0, `${w.name}: resolved nothing`);
    assert.equal(w.cells + w.void, w.width * w.height, `${w.name}: every non-void cell resolved`);
    assert.ok(w.boundaries > 0, `${w.name}: boundaries resolved`);
  }
  assert.ok(c.art.some((p) => p.startsWith("tiles/patterns/")), "the pattern sheets every boundary composes from");
  for (const d of ["tiles/ground_types.json", "tiles/patterns/index.json", "tiles/review/manifest.json"])
    assert.ok(c.docs.includes(d), `boot document ${d}`);
  // A CLOSURE, not the domain: tiles/ is ~400 MB. If this trips, the resolver
  // started naming whole trees and the image would carry them.
  assert.ok(c.art.length > 0 && c.art.length < 8000, `${c.art.length} files`);
  // THE GAME'S RULES, NOT THE PARITY PATH (2026-09-24, production answered 404 for every
  // slope file the game's rule picked that the parity rule had not): a cut's flat tile
  // is in the closure, and so is every tile of every complete bump set of a ground the
  // world uses — his verdicts are live, and a set approved between two deploys must not 404.
  // The slope library was retired by the tiles agent (2026-09-26): while it exists its sets ship, once gone nothing names it.
  if (existsSync(join(REPO, "tiles/slopes/index.json"))) {
    const grassSets = new Set(c.art.filter((p) => p.startsWith("tiles/slopes/grass/")).map((p) => p.split("/")[3]));
    assert.ok(grassSets.size >= 10, `every complete grass slope set ships (${grassSets.size})`);
  } else assert.deepEqual(c.art.filter((p) => p.startsWith("tiles/slopes/")), [], "no retired slope file is named");
  assert.ok(c.bytes < 25e6, `${(c.bytes / 1e6).toFixed(1)} MB of art`);
  assert.deepEqual(tiles3ArtClosure(REPO, worlds).art, c.art, "deterministic");
  console.log(`  ship-tiles3: ${worlds.join(", ")} → ${c.art.length} art files, ${(c.bytes / 1e6).toFixed(2)} MB, ${c.docs.length} documents`);
});

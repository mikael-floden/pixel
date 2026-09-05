#!/usr/bin/env node
/* THE CACHED SCENERY FACTS MUST NOT DRIFT FROM THE ART DOMAIN.
 *
 * `games2/config/scenery-bbox.json` is built by hand (build-scenery-bbox.py)
 * and nothing ran it: measured 2026-09-05 it carried bed_001 at wph 47 / cpx 64
 * while `scenery/beds/bed_001/scenery.json` said 107 / 87 — so the RENDERER drew
 * the bed 108 px tall and `stampSceneryCollision` sized its footprint for 65,
 * 0.60x, with the anchor offset scaled by the same wrong factor so the box was
 * mis-placed as well as too small (the maps agent found it; the maintainer had
 * been looking straight at it: "you just drew a box at the bottom bed corner").
 * Across the library 325 pieces had grown and 385 had shrunk, 0.33x to 6.03x.
 *
 * WHY THIS IS A NODE SCRIPT AND NOT `--check`. The generator's own --check is a
 * byte compare of the WHOLE document and needs Pillow to re-measure every alpha
 * box; CI installs no Python, so wiring it into `npm test` would trade a silent
 * bug for a red pipeline. The half that actually drifts is PLAIN JSON copied out
 * of each `scenery.json` — world_px_height, character_height_px, the sprite, the
 * state map, the flat flag — and that is what this compares. The alpha boxes
 * stay the generator's job (they only move when the ART moves, and they were
 * current); re-run it by hand when they do.
 *
 * A missing `scenery/` tree is NOT a failure: the deploy's test job
 * sparse-checks-out a subset, the same rule shipset's --check-policy follows. */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SRC = join(REPO, "scenery");
const DOC = join(REPO, "games2", "config", "scenery-bbox.json");

if (!existsSync(SRC)) {
  console.log("[scenery-bbox] scenery/ not checked out — skipped");
  process.exit(0);
}
if (!existsSync(DOC)) {
  console.error("[scenery-bbox] games2/config/scenery-bbox.json is MISSING — run games2/scripts/build-scenery-bbox.py");
  process.exit(1);
}
const pieces = JSON.parse(readFileSync(DOC, "utf8")).pieces ?? {};

/** Every directory holding a scenery.json, as the generator keys them. */
const found = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name === "scenery.json") found.push(dir);
  }
};
walk(SRC);

const bad = [];
for (const dir of found) {
  const id = relative(SRC, dir).split(/[\\/]/).join("/");
  let man;
  try { man = JSON.parse(readFileSync(join(dir, "scenery.json"), "utf8")); } catch { continue; }
  const pl = man.placement ?? {};
  const have = pieces[id];
  if (!have) { bad.push(`${id}: absent from the doc`); continue; }
  const want = {
    wph: pl.world_px_height ?? null,
    cpx: pl.character_height_px ?? null,
    sprite: man.sprite ?? null,
    flat: man.collision === false,
  };
  const got = { wph: have.wph ?? null, cpx: have.cpx ?? null, sprite: have.sprite ?? null, flat: !!have.flat };
  for (const k of ["wph", "cpx", "sprite", "flat"]) {
    if (want[k] !== got[k]) bad.push(`${id}.${k}: doc ${JSON.stringify(got[k])} vs scenery.json ${JSON.stringify(want[k])}`);
  }
}

if (bad.length) {
  console.error(`[scenery-bbox] STALE — ${bad.length} disagreement(s) with scenery/. Re-run:`);
  console.error("    python3 games2/scripts/build-scenery-bbox.py");
  for (const b of bad.slice(0, 20)) console.error(`  ${b}`);
  if (bad.length > 20) console.error(`  ... and ${bad.length - 20} more`);
  process.exit(1);
}
console.log(`[scenery-bbox] current — ${found.length} pieces agree with scenery/`);

/* SEEDS live/tuning/base_tile_sets.json FROM WHAT SHIPS TODAY, so the new model
 * starts as a description of the current game rather than as an empty page.
 *
 * The maintainer asked for the hardcoded taxonomy to be retired into sets: "I
 * know today we have hardcoded rules for this, this and this tile should always
 * render with texture and the rest should always render as clean tiles. This
 * should instead just be a matter of how I configure the base tile sets."
 * Retiring it means REPRODUCING it first — a ground that draws its base tile
 * today gets a set holding that tile with Clean switched off; a ground that
 * draws a flat colour today gets Clean alone. Nothing about the game moves on
 * the day this lands; only the place the decision is written moves.
 *
 * Idempotent, and it never overwrites a set the maintainer has touched: run it
 * again and it only adds grounds that have no entry yet.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const GT = JSON.parse(readFileSync("tiles/ground_types.json", "utf8"));
const OUT = "live/tuning/base_tile_sets.json";
const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;

const doc = {
  format: "pixel-wiki-base-tile-sets@1",
  _comment:
    "THE GROUND'S LOOK, per ground type, as the maintainer configures it (2026-08-25). " +
    "Each ground owns an ordered list of SETS. A set is 'a list of tiles that look extremely good when used togather', " +
    "each member carrying a weight for how often it is drawn, plus a 'clean' member for the ground's flat palette colour " +
    "('Setting this to 0% will always draw with texture. Setting this to 100% will always draw a clean tile'). " +
    "The SET carries its own weight for how likely that set is chosen for a region: a world agent picks one set per area and " +
    "stays with it, so an area stays coherent, and varies only within that set. " +
    "SET 0 IS RESERVED: it is named Clean, may hold nothing but the clean member, and is never deleted - it is switched off " +
    "by setting its weight to 0, which also guarantees there is always one set that can draw. " +
    "Ids are stable and are never renumbered when a set is deleted; the display name is '<name> #<id>'. " +
    "Weights are raw non-negative numbers normalised at read time, not stored percentages - adding a tile must not silently " +
    "rescale the others, and 0 has to keep meaning never. " +
    "THIS REPLACES the per-material transition_surface / always_own_texture / flat_top flags. " +
    "Reference implementation and the deterministic pick (FNV-1a/32) in wiki/lib/basesets.mjs, with TEST_VECTORS to prove a port. " +
    "Written by the wiki's ground-type pages; read by the game, the maps/world agent and the tiles agent.",
  pick: {
    hash: "fnv1a-32",
    set_key: "bts1|set|<ground>|<region>",
    tile_key: "bts1|tile|<set_id>|<x>|<y>",
    note:
      "A SET is picked per REGION and a MEMBER per CELL - picking the set per cell would shuffle three different grasses " +
      "into one meadow and undo the point of grouping them. Both picks must be identical in the game, the wiki preview and " +
      "the tiles renders or the ground shimmers between reloads; port wiki/lib/basesets.mjs and check it against TEST_VECTORS.",
  },
  updated_at: new Date().toISOString(),
  grounds: {},
};

let seeded = 0, kept = 0;
for (const [ground, g] of Object.entries(GT.grounds).sort()) {
  if (prev?.grounds?.[ground]) { doc.grounds[ground] = prev.grounds[ground]; kept++; continue; }
  const tiles = Array.isArray(g.base_tiles) ? g.base_tiles.filter(Boolean) : [];
  const sets = [{ id: 0, name: "Clean", weight: tiles.length ? 0 : 1, members: [{ kind: "clean", weight: 1 }] }];
  if (tiles.length) {
    sets.push({
      id: 1,
      name: "Set",
      weight: 1,
      members: [{ kind: "clean", weight: 0 }, ...tiles.map((t) => ({ kind: "tile", id: null, tile: t, weight: 1 }))],
    });
  }
  doc.grounds[ground] = { sets };
  seeded++;
}

writeFileSync(OUT, JSON.stringify(doc, null, 1) + "\n");
console.log(`${OUT}: ${seeded} seeded, ${kept} kept untouched, ${Object.keys(doc.grounds).length} grounds`);
for (const [k, v] of Object.entries(doc.grounds)) {
  const on = v.sets.filter((s) => s.weight > 0).map((s) => `${s.name} #${s.id}`);
  console.log(`  ${k.padEnd(20)} ${v.sets.length} set(s), drawing: ${on.join(", ") || "NOTHING (all weights 0)"}`);
}

/* BASE TILE SETS — the reference implementation, shared by the wiki, the game
 * and the tiles pipeline.
 *
 * The maintainer's model (2026-08-25), in his words:
 *
 *   "Each ground type have a list of base tile sets. A base tile set is a list
 *   of tiles that look extremely good when used together. This set other then
 *   just defining what tiles should be in this set - should also specify how
 *   likley (the weight/chance) tile_1 is to be used VS tile_2 ... In every base
 *   tile set the set can add a weight for how likley the clean/plain color
 *   should be used. Setting this to 0% will always draw with texture. Setting
 *   this to 100% will always draw a clean tile."
 *
 *   "Why do each tile type have several base tile sets? Because on one side of
 *   the world we can make the grass look different, but still look nice vs
 *   another side of the world. And the world-agent will always stick to a
 *   single base tile set at one location so it will always look good."
 *
 * TWO LEVELS OF CHOICE, AND THEY ARE NOT THE SAME CHOICE. A SET is chosen per
 * REGION — one set for a whole area, which is what keeps an area coherent. A
 * MEMBER is chosen per CELL, which is what makes the field vary. Picking the
 * set per cell would shuffle three different grasses into one meadow and undo
 * the entire point of grouping them.
 *
 * THIS REPLACES THE HARDCODED TAXONOMY. transition_surface own/base/flat and
 * always_own_texture decided per material whether a ground drew its texture or
 * a clean colour. Now he decides, per set: "I will for paving stone as an
 * example create a lot of different paving stone base tile sets that never uses
 * a clean color. This gives the effect that paving stone can never be drawn
 * with a clean/plain color. It's all normalized and controlled using the base
 * tile sets."
 *
 * DETERMINISM IS THE WHOLE CONTRACT. The game, the wiki's preview and the tiles
 * agent's renders must resolve the same cell to the same tile or the ground
 * shimmers between reloads and every screenshot argues with the last one. So
 * the pick is a pure function of (ground, set, coordinates) through a hash
 * specified here to the bit — FNV-1a/32, which is four lines in any language —
 * and TEST_VECTORS below exists so a port can be proven right without reading
 * this file.
 */

export const SCHEMA = "pixel-wiki-base-tile-sets@1";

/* Set 0 is reserved, is named Clean, and may hold nothing but the clean member.
 * "let's say all tile types always have a default Set #0 that is special and
 * can only contain 100% the clean/plain base color. How I get the map-agent to
 * never use that default set is to set the likleyness for this set being used
 * to 0%." So Clean is never deleted — it is switched off by weight, which also
 * means there is always one set that can draw. */
export const CLEAN_SET_ID = 0;

/* FNV-1a, 32-bit, THEN AN AVALANCHE FINALIZER. Both halves are required.
 *
 * FNV-1a alone is portable and fast but it does NOT avalanche at the tail: the
 * last byte is XORed in and multiplied exactly once, so it moves mostly the LOW
 * bits, while a value taken as h/2^32 is dominated by the HIGH ones. Our keys
 * end in the coordinate that varies — "…|<x>|<y>" — so consecutive rows landed
 * in the same bucket almost every time.
 *
 * MEASURED, on a 60x60 field of a 7-tile set: a cell matched the one BELOW it
 * 89.2% of the time against a 14.3% chance, with runs of 50 identical tiles
 * down a column. That is the "vertical stripes" the maintainer reported
 * (2026-08-27: "Why would we holding on to a tile to create vertical visible
 * stripes?") — not a quirk of his eye, and not confined to the wiki: this is
 * the spec the game and the tiles agent port, so the world would have shipped
 * the stripes.
 *
 * The finalizer is MurmurHash3's fmix32, five integer ops, as portable as the
 * rest. After it: 13.5% below and 14.6% right against 14.3% expected. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // fmix32 — spreads every input bit across all 32 output bits.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/* A hash in [0,1). 2^32 as the divisor, so the value can reach 0 but never 1
 * and the last bucket cannot be skipped by rounding. */
export const unitHash = (str) => fnv1a(str) / 4294967296;

/* Weighted pick over a list of non-negative weights, given u in [0,1).
 *
 * Weights are stored RAW and normalised here, not stored as percentages: adding
 * a tile to a set then does not silently rescale every other tile in it, and 0
 * keeps meaning never — which is exactly how he asked for it ("the weight for
 * using this set is 0").
 *
 * Returns -1 when nothing can be picked (empty list, or every weight 0). The
 * caller decides the fallback; this function does not invent one. */
export function pickWeighted(weights, u) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return -1;
  let acc = 0;
  const target = u * total;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] > 0 ? weights[i] : 0;
    if (target < acc) return i;
  }
  /* Only reachable on floating-point crumbs at the very top of the range. Fall
   * to the last positive weight rather than to the last INDEX — the last index
   * may be a zero-weight member, and "never" has to mean never even here. */
  for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return -1;
}

/* The sets of one ground, always with Clean present and always sorted by id, so
 * every reader sees the same order whatever the file happens to hold. A ground
 * with no entry at all still gets Clean — the model has no "no sets" state. */
export function setsFor(doc, ground) {
  const raw = doc?.grounds?.[ground]?.sets;
  const list = Array.isArray(raw) ? raw.slice() : [];
  if (!list.some((s) => s && s.id === CLEAN_SET_ID)) {
    list.push({ id: CLEAN_SET_ID, name: "Clean", weight: 1, members: [{ kind: "clean", weight: 1 }] });
  }
  return list
    .filter((s) => s && Number.isInteger(s.id) && s.id >= 0)
    .sort((a, b) => a.id - b.id)
    .map((s) => ({
      id: s.id,
      name: typeof s.name === "string" && s.name ? s.name : s.id === CLEAN_SET_ID ? "Clean" : "Set",
      weight: Math.max(0, Number(s.weight) || 0),
      members: normaliseMembers(s.id, s.members),
    }));
}

/* Clean is a MEMBER, not a flag beside the members — "the set can add a weight
 * for how likley the clean/plain color should be used", the same kind of weight
 * a tile gets. Every set carries exactly one clean member so the UI always has
 * a row to show and 0% is expressible; set 0 carries nothing else. */
function normaliseMembers(setId, members) {
  const src = Array.isArray(members) ? members : [];
  const tiles = setId === CLEAN_SET_ID
    ? []
    : src.filter((m) => m && m.kind === "tile" && typeof m.tile === "string" && m.tile)
         .map((m) => ({ kind: "tile", id: typeof m.id === "string" ? m.id : null, tile: m.tile, weight: Math.max(0, Number(m.weight) || 0) }));
  const clean = src.find((m) => m && m.kind === "clean");
  const cleanWeight = clean ? Math.max(0, Number(clean.weight) || 0) : (tiles.length ? 0 : 1);
  return [{ kind: "clean", weight: cleanWeight }, ...tiles];
}

/* The percentage HE reads, from the weights the file stores. Shown beside every
 * row because percent is how he stated the model ("Setting this to 0%... to
 * 100%") while a raw weight is what survives editing without rescaling. */
export function shares(weights) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return weights.map(() => 0);
  return weights.map((w) => (w > 0 ? w : 0) / total);
}

/* WHICH SET PAINTS THIS REGION. `region` is an opaque string owned by the world
 * agent — a region id, a chunk key, whatever it decides an "area" is. All this
 * guarantees is that the same region always resolves to the same set.
 *
 * Every weight 0 falls back to Clean rather than to nothing: he can switch every
 * set off, and the ground still has to draw. */
export function pickSet(doc, ground, region) {
  const sets = setsFor(doc, ground);
  const i = pickWeighted(sets.map((s) => s.weight), unitHash(`bts1|set|${ground}|${region}`));
  return i < 0 ? sets.find((s) => s.id === CLEAN_SET_ID) : sets[i];
}

/* WHICH TILE FILLS THIS CELL. Keyed by the SET ID and not by the set's position,
 * so reordering or deleting another set does not repaint a field that nobody
 * touched. Returns the clean member as {kind:"clean"} — the caller fills with
 * the ground's palette colour, which lives in the tiles agent's ground_types,
 * not here. */
export function pickMember(set, x, y) {
  if (!set || !set.members?.length) return { kind: "clean", weight: 1 };
  const i = pickWeighted(set.members.map((m) => m.weight), unitHash(`bts1|tile|${set.id}|${x}|${y}`));
  return i < 0 ? { kind: "clean", weight: 1 } : set.members[i];
}

/* One call for the common case: what does this cell of this region look like. */
export function tileAt(doc, ground, region, x, y) {
  const set = pickSet(doc, ground, region);
  return { set, member: pickMember(set, x, y) };
}

/* PROVE A PORT WITHOUT READING THIS FILE. Any reimplementation that reproduces
 * these lines is compatible; one that does not will make the ground disagree
 * with itself between the game and the wiki, which is the exact bug this table
 * exists to make impossible to ship. Regenerate with wiki/tools/baseset-vectors.mjs. */
export const TEST_VECTORS = {
  fnv1a: [
    ["", 2872998923],
    ["a", 444641715],
    ["grass", 876385684],
    ["bts1|set|grass|r0", 876574184],
    ["bts1|tile|1|0|0", 1995477220],
  ],
  pickWeighted: [
    [[1, 1], 0, 0],
    [[1, 1], 0.4999, 0],
    [[1, 1], 0.5, 1],
    [[0, 5], 0, 1],
    [[0, 5], 0.999, 1],
    [[3, 1], 0.74, 0],
    [[3, 1], 0.76, 1],
    [[0, 0], 0.5, -1],
    [[], 0.5, -1],
  ],
};

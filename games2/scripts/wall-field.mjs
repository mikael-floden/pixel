/** WHAT A WALL FACE ACTUALLY LOOKS LIKE, measured on the SURFACE.
 *
 * A wall is a floor stood on its edge (maintainer 2026-09-07: "think the wall is
 * tilted 90 degrees (becomes floor) ... of course you don't think on columns
 * when it comes to today's ground"), so it is measured the way you would
 * measure ground: in pixels, on the surface, with both directions treated
 * alike. The earlier version of this tool reported "colSeam" and "rowStripe" —
 * the longest run of a boundary along a column and along a storey — and those
 * were the wrong question twice over. They presume a constant-tile patch WITH
 * an edge, which the rule no longer produces, and they treat the two axes as
 * different kinds of thing, which is the column-thinking itself.
 *
 * REAL GEOMETRY, not a convenient slab. A storey is 15px and a cell step along
 * a face is sqrt(32^2+14^2) = 34.9px. Faces in the_game run to 40 storeys
 * (median 4, p90 14, p99 36), i.e. 600px and 17.2 cell-steps tall, so the tall
 * ones are sampled here rather than a 16-storey stump.
 *
 *   npx tsx games2/scripts/wall-field.mjs [--show]
 */
import { wallField, pickWallIndex, WALL_STOREY_CELLS } from "../client/src/wallregion.ts";

const PITCH = 15;
const STEP = Math.sqrt(32 * 32 + 14 * 14);
const H = 40;                       // the tallest face the world actually has
const W = 90;                       // a long run of wall
const LINES = [7, 23, 40, 61, 90, 128, 171, 200, 244, 301, 340, 377];
const POOL = "grey_stone__over__grey_stone";
const KEYS = Array.from({ length: 74 }, (_, i) => `k${i}`);

/** Region patches on one face: their extent in PIXELS, and their aspect. */
const aspects = [];
const widths = [];
const heights = [];
let neighbourSame = 0;
let neighbourTotal = 0;

for (const along of ["x", "y"]) {
  for (const fixed of LINES) {
    const box = new Map();
    for (let z = 0; z < H; z++)
      for (let i = 0; i < W; i++) {
        const [x, y] = along === "x" ? [i, fixed] : [fixed, i];
        const r = wallField(x, y, z).region;
        const b = box.get(r) ?? { i0: i, i1: i, z0: z, z1: z };
        b.i0 = Math.min(b.i0, i); b.i1 = Math.max(b.i1, i);
        b.z0 = Math.min(b.z0, z); b.z1 = Math.max(b.z1, z);
        box.set(r, b);
        // Per-cell variation: does the neighbour up the wall wear the same tile?
        if (z > 0) {
          const a = pickWallIndex(POOL, KEYS, x, y, z);
          const c = pickWallIndex(POOL, KEYS, x, y, z - 1);
          if (a === c) neighbourSame++;
          neighbourTotal++;
        }
      }
    for (const b of box.values()) {
      // Ignore patches clipped by the sample window — their extent is the
      // window's, not theirs, and they would drag the aspect toward the slab's.
      if (b.i0 === 0 || b.i1 === W - 1 || b.z0 === 0 || b.z1 === H - 1) continue;
      const wpx = (b.i1 - b.i0 + 1) * STEP;
      const hpx = (b.z1 - b.z0 + 1) * PITCH;
      widths.push(wpx); heights.push(hpx); aspects.push(wpx / hpx);
    }
  }
}
const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
console.log(JSON.stringify({
  storeyCells: WALL_STOREY_CELLS,
  patches: aspects.length,
  medianWidthPx: Math.round(med(widths)),
  medianHeightPx: Math.round(med(heights)),
  medianAspect: +med(aspects).toFixed(2),
  aspectP10: +[...aspects].sort((a, b) => a - b)[Math.floor(aspects.length * 0.1)].toFixed(2),
  aspectP90: +[...aspects].sort((a, b) => a - b)[Math.floor(aspects.length * 0.9)].toFixed(2),
  neighbourSameShare: +(neighbourSame / neighbourTotal).toFixed(3),
}, null, 2));

if (process.argv.includes("--show")) {
  const { wallPalette } = await import("../client/src/wallregion.ts");
  for (const [label, at] of [
    ["a face running along X (y=40), 40 storeys — the tallest the world has", (i, z) => [i, 40, z]],
    ["a face running along Y (x=40)", (i, z) => [40, i, z]],
  ]) {
    console.log(`\n--- ${label} ---`);
    console.log("    palette slot per cell: # dominant, + secondary, . accent");
    for (let z = H - 1; z >= 0; z--) {
      let r = "";
      for (let i = 0; i < 78; i++) {
        const [x, y, zz] = at(i, z);
        const f = wallField(x, y, zz);
        const pal = wallPalette(POOL, f.region, KEYS);
        const k = pickWallIndex(POOL, KEYS, x, y, zz);
        r += "#+."[pal.indexOf(k)] ?? "?";
      }
      console.log(String(z).padStart(2) + " " + r);
    }
  }
}

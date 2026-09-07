/** THE WALL FIELD'S TWO FAILURE METRICS, measured over a slab of wall.
 *
 * The maintainer's rule for wall variety is "DON'T MAKE IT FEEL RANDOM. Organic
 * is the key word", and he named the two ways it goes wrong. Both are geometric
 * and both are measurable, so neither is a matter of opinion:
 *
 *   colSeam    the most storeys a tile boundary keeps the SAME x — a boundary
 *              that holds one column for many storeys IS "a whole column
 *              switching".
 *   rowStripe  the most cells a boundary keeps the SAME storey — that is "a
 *              per-storey stripe".
 *
 * Run after touching any constant in client/src/wallregion.ts:
 *   npx tsx games2/scripts/wall-field.mjs
 */
import { wallField } from "../client/src/wallregion.ts";

const W = 120;
const H = 16;
const ROWS = [7, 23, 40, 61, 90, 128, 171, 200, 244, 301, 340, 377];

let horiz = [];
let vert = [];
let colSeam = 0;
let rowStripe = 0;
const regions = new Set();

for (const y of ROWS) {
  const g = [];
  for (let z = 0; z < H; z++) {
    g[z] = [];
    for (let x = 0; x < W; x++) {
      g[z][x] = wallField(x, y, z).micro;
      regions.add(g[z][x]);
    }
  }
  for (let z = 0; z < H; z++) {
    let run = 1;
    for (let x = 1; x < W; x++) {
      if (g[z][x] === g[z][x - 1]) run++;
      else { horiz.push(run); run = 1; }
    }
    horiz.push(run);
  }
  for (let x = 0; x < W; x++) {
    let run = 1;
    for (let z = 1; z < H; z++) {
      if (g[z][x] === g[z - 1][x]) run++;
      else { vert.push(run); run = 1; }
    }
    vert.push(run);
  }
  for (let x = 1; x < W; x++) {
    let s = 0, best = 0;
    for (let z = 0; z < H; z++) { if (g[z][x] !== g[z][x - 1]) { s++; if (s > best) best = s; } else s = 0; }
    if (best > colSeam) colSeam = best;
  }
  for (let z = 1; z < H; z++) {
    let s = 0, best = 0;
    for (let x = 0; x < W; x++) { if (g[z][x] !== g[z - 1][x]) { s++; if (s > best) best = s; } else s = 0; }
    if (best > rowStripe) rowStripe = best;
  }
}
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
console.log(JSON.stringify({
  patchCells: +avg(horiz).toFixed(1),
  patchStoreys: +avg(vert).toFixed(1),
  colSeam,
  rowStripe,
  regions: regions.size,
}, null, 2));

/* A picture, because "organic" is finally a thing you look at. */
if (process.argv.includes("--show")) {
  const { pickWallIndex } = await import("../client/src/wallregion.ts");
  for (const [label, at] of [
    ["a face running along X (y=40)", (i, z) => [i, 40, z]],
    ["a face running along Y (x=40)", (i, z) => [40, i, z]],
  ]) {
    console.log(`\n--- ${label} ---`);
    for (let z = H - 1; z >= 0; z--) {
      let r = "";
      for (let i = 0; i < 78; i++) {
        const [x, y, zz] = at(i, z);
        const k = pickWallIndex("demo__over__demo", 24, x, y, zz);
        r += k === pickWallIndex("demo__over__demo", 24, 0, 0, 0) ? "#" : k % 2 ? "+" : ".";
      }
      console.log(String(z).padStart(2) + " " + r);
    }
  }
}

// "Study each tile": bake a per-pixel SHADOW WEIGHT map for every tile the
// world uses — how strongly the artist shaded each pixel, relative to the
// tile's own top-face brightness. The night shader modulates its wall-shadow
// gate by this weight, so the shadow's SHAPE is the tile's drawn shape:
// deep crevice pixels take full shadow, bright overhang pixels keep light,
// transparent pixels take none. Output: an atlas PNG (grid of 64x64 maps,
// weight in R) + a JSON index "cat/variant" -> slot.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";
import { execSync } from "node:child_process";

const TILES = "/home/user/pixel/tiles";
const WORLD = "/home/user/pixel/maps/world/world.json";
const OUT_PNG = new URL("../client/public/tile-shadows.png", import.meta.url).pathname;
const OUT_JSON = new URL("../client/public/tile-shadows.json", import.meta.url).pathname;
const W = 64, TOP = 8, MID = 21, BOT = 34, WALL = 19;
const aLip = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

// Distinct tiles used by the world (via the shared parser, run through tsx).
const usedJson = execSync(
  `npx tsx -e "
import { readFileSync } from 'node:fs';
import { parseWorld } from './shared/src/index.ts';
const w = parseWorld(JSON.parse(readFileSync('${WORLD}','utf8')));
const s = new Set();
for (const row of w.rows) for (const c of row) if (c) s.add(c.t+'/'+(c.v??0));
console.log(JSON.stringify([...s]));
"`,
  { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
);
const used = JSON.parse(usedJson.trim().split("\n").pop());

function weightsFor(file) {
  const p = PNG.sync.read(readFileSync(file));
  if (p.width !== W || p.height !== W) return null;
  const lum = (x, y) => {
    const i = (y * W + x) * 4;
    if (p.data[i + 3] <= 16) return null;
    return 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2];
  };
  // Reference brightness: the tile's own top face (above the analytic lip).
  const tops = [], walls = [];
  for (let x = 2; x < W - 2; x++)
    for (let y = TOP; y < BOT + WALL; y++) {
      const l = lum(x, y);
      if (l === null) continue;
      if (y < aLip(x) - 2) tops.push(l);
      else if (y > aLip(x) + 2) walls.push(l);
    }
  if (tops.length < 40) return null;
  tops.sort((a, b) => a - b);
  walls.sort((a, b) => a - b);
  // Normalize WITHIN the wall's own luminance range: some tiles draw walls
  // brighter than tops (grass' dirt face) — vs-top normalization zeroed
  // their whole face and disabled the shadow entirely. Every opaque face
  // pixel shadows at least at FLOOR strength; crevices go to full.
  const FLOOR = 0.4;
  const wallLo = walls.length ? walls[Math.floor(walls.length * 0.1)] : 0;
  const wallHi = walls.length ? walls[Math.floor(walls.length * 0.9)] : 255;
  const range = Math.max(wallHi - wallLo, 12);
  const w8 = new Uint8Array(W * W);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const l = lum(x, y);
      if (l === null) { w8[y * W + x] = 0; continue; } // transparent: NO shadow
      const t = Math.max(0, Math.min(1, (wallHi - l) / range));
      const s = t * t * (3 - 2 * t); // smoothstep shaping
      w8[y * W + x] = Math.round(255 * (FLOOR + (1 - FLOOR) * s));
    }
  return w8;
}

const slots = [];
const index = {};
for (const key of used.sort()) {
  const [cat, v] = key.split("/");
  const file = `${TILES}/${cat}/tile_${String(v).padStart(2, "0")}.png`;
  if (!existsSync(file)) continue;
  const w8 = weightsFor(file);
  if (!w8) continue;
  index[key] = slots.length;
  slots.push(w8);
}

const COLS = 20;
const rows = Math.ceil(slots.length / COLS);
const atlas = new PNG({ width: COLS * W, height: rows * W });
slots.forEach((w8, s) => {
  const ox = (s % COLS) * W, oy = Math.floor(s / COLS) * W;
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = ((oy + y) * atlas.width + ox + x) * 4;
      atlas.data[i] = w8[y * W + x];
      atlas.data[i + 3] = 255;
    }
});
writeFileSync(OUT_PNG, PNG.sync.write(atlas));
writeFileSync(OUT_JSON, JSON.stringify({ format: "tile-shadows@1", cols: COLS, tile: W, slots: slots.length, index }));
console.log(`baked ${slots.length}/${used.length} used tiles -> atlas ${atlas.width}x${atlas.height}`);
// Spot stats for the playtester's tiles.
for (const k of ["meadow/0", "grass/0", "flowers/0"]) {
  const s = index[k];
  if (s === undefined) continue;
  const w8 = slots[s];
  let wallSum = 0, wallN = 0, topSum = 0, topN = 0;
  for (let x = 2; x < W - 2; x++)
    for (let y = TOP; y < BOT + WALL; y++) {
      const v = w8[y * W + x];
      if (y < aLip(x) - 2) { topSum += v; topN++; }
      else if (y > aLip(x) + 2) { wallSum += v; wallN++; }
    }
  console.log(`  ${k}: mean weight top ${(topSum / topN / 255).toFixed(2)} wall ${(wallSum / wallN / 255).toFixed(2)}`);
}

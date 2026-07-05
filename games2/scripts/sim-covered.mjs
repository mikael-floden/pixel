// Numeric replica of WorldScene's per-frame "covered" decision (the test that
// hides the lit top-copy). Scans shoreline cells near spawn and reports, for a
// character standing at each cell centre, whether covered flips true and WHICH
// occluder triggers it. Pure data — no browser, no screenshots.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const shared = await import(join(here, "../shared/src/index.ts"));
const { parseWorld, surfaceFor } = shared;

const world = parseWorld(JSON.parse(readFileSync(join(root, "maps/world/world.json"), "utf8")));
if (!world) throw new Error("world parse failed");
const { rows, width: W, height: H } = world;

const dx = 32, dy = 13, lh = 19, tile = 64;
const ox = 0, oy = 0;
const DISP_W = 128, DISP_H = 128; // avatar frame at scale 1

function occludersNear(cf, rf, radius = 8) {
  const out = [];
  const c0 = Math.max(0, Math.floor(cf) - radius), c1 = Math.min(W - 1, Math.floor(cf) + radius);
  const r0 = Math.max(0, Math.floor(rf) - radius), r1 = Math.min(H - 1, Math.floor(rf) + radius);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const cell = rows[r]?.[c];
    if (!cell) continue;
    const s = surfaceFor(cell.t);
    const tall = cell.l > 0 || (!s.standable && !s.swimmable);
    if (!tall) continue;
    const u = c - r, v = c + r;
    const bx = ox + u * dx, by = oy + v * dy;
    out.push({
      col: c, row: r, t: cell.t, l: cell.l,
      top: cell.l + (s.standable ? 0 : 1),
      x0: bx, x1: bx + tile, y0: by - cell.l * lh, y1: by + tile,
    });
  }
  return out;
}

// EXACT copy of the update() decision for feet at fractional grid (colf,rowf).
// MODE 'frame' = live code (full 128px frame box); 'body' = measured opaque
// art bounds (~30x68, feet at frame y=96..98) + the same 4px margin.
const MODE = process.argv[2] === "body" ? "body" : "frame";
function coveredAt(colf, rowf) {
  const cell = rows[Math.floor(rowf)]?.[Math.floor(colf)];
  if (!cell) return null;
  const lvl = cell.l; // levelAtWorld
  const lx = ox + (colf - rowf) * dx + tile / 2;
  const feetY = oy + (colf + rowf) * dy + dy - lvl * lh;
  const spriteY = feetY; // no hop/sink
  let sx0, sx1, sy0, sy1;
  if (MODE === "body") {
    sx0 = lx - 16 - 4; sx1 = lx + 16 + 4;
    sy0 = feetY - 67 - 4; sy1 = feetY + 2 + 4;
  } else {
    sx0 = lx - DISP_W / 2 - 4; sx1 = lx + DISP_W / 2 + 4;
    sy0 = spriteY - DISP_H - 4; sy1 = spriteY + 8;
  }
  const hits = [];
  for (const o of occludersNear(colf, rowf)) {
    if (o.x1 < sx0 || o.x0 > sx1 || o.y1 < sy0 || o.y0 > sy1) continue;
    const higher = o.top > lvl;
    const t0 = Math.max(o.col - colf, o.row - rowf);
    const t1 = Math.min(o.col + 1 - colf, o.row + 1 - rowf);
    const rayBlocked = higher && t1 > Math.max(t0, 0);
    const faceOverFeet =
      higher && o.y0 <= feetY + 6 && o.y0 >= feetY - 26 && o.col + o.row + 1.2 > colf + rowf;
    if (rayBlocked || faceOverFeet)
      hits.push({
        oc: `${o.col},${o.row} ${o.t} l${o.l} top${o.top}`,
        dCol: o.col - Math.floor(colf), dRow: o.row - Math.floor(rowf),
        y0MinusFeet: Math.round(o.y0 - feetY),
        rayBlocked, faceOverFeet,
      });
  }
  return { lvl, t: cell.t, hits, covered: hits.length > 0 };
}

// Chebyshev distance to nearest water cell.
function distToWater(c, r, max = 6) {
  for (let d = 1; d <= max; d++) {
    for (let rr = r - d; rr <= r + d; rr++) for (let cc = c - d; cc <= c + d; cc++) {
      if (Math.max(Math.abs(rr - r), Math.abs(cc - c)) !== d) continue;
      const cell = rows[rr]?.[cc];
      if (cell && surfaceFor(cell.t).swimmable) return d;
    }
  }
  return Infinity;
}

// Scan around spawn (campfire ~259,225) out to the nearest sea.
const SC = 259, SR = 225, R = 70;
const byDist = new Map(); // waterDist -> {covered, total, examples}
for (let r = Math.max(0, SR - R); r <= Math.min(H - 1, SR + R); r++) {
  for (let c = Math.max(0, SC - R); c <= Math.min(W - 1, SC + R); c++) {
    const cell = rows[r]?.[c];
    if (!cell || !surfaceFor(cell.t).standable) continue;
    const wd = distToWater(c, r, 4);
    if (wd > 4) continue;
    const res = coveredAt(c + 0.5, r + 0.5);
    if (!res) continue;
    const b = byDist.get(wd) ?? { covered: 0, total: 0, ex: [] };
    b.total++;
    if (res.covered) {
      b.covered++;
      if (b.ex.length < 4) b.ex.push({ at: `${c},${r} ${res.t} l${res.lvl}`, hits: res.hits });
    }
    byDist.set(wd, b);
  }
}
for (const d of [...byDist.keys()].sort()) {
  const b = byDist.get(d);
  console.log(`water-dist ${d}: covered ${b.covered}/${b.total} (${Math.round((100 * b.covered) / b.total)}%)`);
  for (const e of b.ex) console.log(`   e.g. stand ${e.at} -> ${JSON.stringify(e.hits)}`);
}

// Crop-rule outcome: crop the lit copy below the HIGHEST triggering occluder
// top (min y0-feetY). Classify how much of the 67px-tall body stays lit.
const buckets = { open: 0, sliverBelowKnee: 0, waistUp: 0, headOnly: 0, fullyHidden: 0 };
for (let r = Math.max(0, SR - R); r <= Math.min(H - 1, SR + R); r++) {
  for (let c = Math.max(0, SC - R); c <= Math.min(W - 1, SC + R); c++) {
    const cell = rows[r]?.[c];
    if (!cell || !surfaceFor(cell.t).standable) continue;
    if (distToWater(c, r, 4) > 4) continue;
    const res = coveredAt(c + 0.5, r + 0.5);
    if (!res) continue;
    if (!res.covered) { buckets.open++; continue; }
    const cropTop = Math.min(...res.hits.map((h) => h.y0MinusFeet)); // px above feet where lit copy ends
    if (cropTop >= -15) buckets.sliverBelowKnee++;       // ≥52px of body stays lit
    else if (cropTop >= -40) buckets.waistUp++;          // torso+head lit
    else if (cropTop >= -67) buckets.headOnly++;         // only head lit
    else buckets.fullyHidden++;                          // wall truly covers all
  }
}
console.log("crop-rule outcome near shore:", JSON.stringify(buckets));

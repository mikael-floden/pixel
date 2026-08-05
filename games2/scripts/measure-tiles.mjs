// Stage 1 of art-aware shadows: measure how far each tile PNG's REAL pixels
// deviate from the ideal iso block the night shader assumes (top diamond rows
// 8..34, walls down to row 53; dx=32, dy=13, lh=19). The deviation IS the
// visible shadow error, so this ranks which tiles break the illusion worst.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { PNG } from "pngjs";

const TILES = "/home/user/pixel/tiles";
const W = 64, TOP = 8, MID = 21, BOT = 34, WALL = 19; // ideal geometry
const FLOOR = BOT + WALL; // 53: ideal bottom vertex of the wall silhouette

// Ideal block silhouette: for column x, the top edge row and bottom edge row.
function idealEdges(x) {
  const t = Math.abs(x + 0.5 - W / 2) / (W / 2); // 0 centre → 1 side
  const topY = TOP + t * (MID - TOP); // diamond upper edge
  const botY = FLOOR - t * (MID - TOP) + (t === 1 ? 0 : 0); // wall lower edge
  return { topY, botY };
}

function measure(file) {
  const p = PNG.sync.read(readFileSync(file));
  if (p.width !== W || p.height !== W) return null;
  const alpha = (x, y) => p.data[(y * p.width + x) * 4 + 3] > 16;
  let extra = 0, missing = 0, ideal = 0;
  let sumTopDev = 0, maxTopDev = 0, sumBotDev = 0, maxBotDev = 0, cols = 0;
  for (let x = 0; x < W; x++) {
    const { topY, botY } = idealEdges(x);
    // Actual highest/lowest opaque row in this column.
    let hi = -1, lo = -1;
    for (let y = 0; y < p.height; y++) if (alpha(x, y)) { if (hi < 0) hi = y; lo = y; }
    for (let y = 0; y < p.height; y++) {
      const inIdeal = y >= topY && y <= botY;
      if (inIdeal) ideal++;
      if (alpha(x, y) && !inIdeal) extra++;
      if (!alpha(x, y) && inIdeal) missing++;
    }
    if (hi >= 0) {
      const tDev = Math.abs(hi - topY);
      const bDev = Math.abs(lo - botY);
      sumTopDev += tDev; maxTopDev = Math.max(maxTopDev, tDev);
      sumBotDev += bDev; maxBotDev = Math.max(maxBotDev, bDev);
      cols++;
    }
  }
  return {
    extraPct: (100 * extra) / ideal,
    missingPct: (100 * missing) / ideal,
    topDev: sumTopDev / cols,
    topMax: maxTopDev,
    botDev: sumBotDev / cols,
    botMax: maxBotDev,
  };
}

const rows = [];
for (const cat of readdirSync(TILES)) {
  const f = `${TILES}/${cat}/tile_00.png`;
  if (!existsSync(f)) continue;
  const m = measure(f);
  if (!m) continue;
  // Error score: mean edge deviation weighted + shape mismatch. Bottom edge
  // (the wall/ground boundary — the chevron in the user's screenshots) counts
  // double: that is where the shadow error shows.
  const score = m.botDev * 2 + m.topDev + (m.extraPct + m.missingPct) / 10;
  rows.push({ cat, score, ...m });
}
rows.sort((a, b) => b.score - a.score);
const fmt = (r) =>
  `${r.cat.padEnd(28)} score ${r.score.toFixed(1).padStart(5)}  botDev ${r.botDev.toFixed(1)}/${r.botMax} topDev ${r.topDev.toFixed(1)}/${r.topMax}  extra ${r.extraPct.toFixed(0)}% missing ${r.missingPct.toFixed(0)}%`;
console.log("== worst 20 (biggest shadow error) ==");
rows.slice(0, 20).forEach((r) => console.log(fmt(r)));
console.log("== best 10 (most 'squary') ==");
rows.slice(-10).forEach((r) => console.log(fmt(r)));
const spawn = ["meadow", "grass", "flowers", "dirt", "forest", "water", "sand", "cliff_grass", "grass_ledge"];
console.log("== spawn-area tiles ==");
for (const c of spawn) {
  const r = rows.find((x) => x.cat === c);
  if (r) console.log(`#${rows.indexOf(r) + 1}`.padEnd(5) + fmt(r));
}

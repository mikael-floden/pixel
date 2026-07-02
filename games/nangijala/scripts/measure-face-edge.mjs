// Stage 1b: find the DRAWN boundary between a tile's top surface and its wall
// face (iso art draws walls darker), and compare it per column against the
// analytic boundary the shader uses (diamond lower edges, rows 21->34->21).
// The per-column deviation IS the chevron error from the user's screenshots.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const W = 64, TOP = 8, MID = 21, BOT = 34;

function lum(p, x, y) {
  const i = (y * p.width + x) * 4;
  if (p.data[i + 3] <= 16) return null;
  return 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2];
}

// Analytic top-face lower edge for column x (the "V"): row 21 at sides -> 34 centre.
const analyticEdge = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

function measure(cat) {
  const p = PNG.sync.read(readFileSync(`/home/user/pixel/tiles/${cat}/tile_00.png`));
  const devs = [];
  for (let x = 2; x < W - 2; x++) {
    const aEdge = analyticEdge(x);
    // Mean luminance of the top face zone vs the wall zone in this column.
    // Then find the row (searching a wide band around the analytic edge) with
    // the strongest persistent downward luminance step = drawn edge.
    let best = null, bestDrop = 6; // require a real step (>6 luminance)
    for (let y = Math.max(TOP + 2, aEdge - 14); y <= Math.min(60, aEdge + 14); y++) {
      const above = [lum(p, x, y - 2), lum(p, x, y - 1)].filter((v) => v !== null);
      const below = [lum(p, x, y + 1), lum(p, x, y + 2), lum(p, x, y + 3)].filter((v) => v !== null);
      if (above.length < 2 || below.length < 3) continue;
      const drop = above.reduce((a, b) => a + b) / above.length - below.reduce((a, b) => a + b) / below.length;
      if (drop > bestDrop) { bestDrop = drop; best = y; }
    }
    if (best !== null) devs.push(best - aEdge); // + = drawn edge BELOW analytic
  }
  if (!devs.length) return null;
  const mean = devs.reduce((a, b) => a + b) / devs.length;
  const absMean = devs.reduce((a, b) => a + Math.abs(b), 0) / devs.length;
  const max = Math.max(...devs.map(Math.abs));
  const spread = Math.sqrt(devs.reduce((a, b) => a + (b - mean) ** 2, 0) / devs.length);
  return { cols: devs.length, mean, absMean, max, spread };
}

for (const cat of ["meadow", "grass", "flowers", "dirt", "forest", "stone", "sand", "cliff_grass", "water"]) {
  try {
    const m = measure(cat);
    console.log(
      m
        ? `${cat.padEnd(12)} cols ${String(m.cols).padStart(2)}  meanDev ${m.mean.toFixed(1)}px  |dev| ${m.absMean.toFixed(1)}px  max ${m.max.toFixed(0)}px  raggedness(sd) ${m.spread.toFixed(1)}px`
        : `${cat.padEnd(12)} no clear drawn edge found`,
    );
  } catch (e) {
    console.log(`${cat.padEnd(12)} skip (${e.message})`);
  }
}

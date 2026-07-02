// Stage B1 of art-aware shadows: bake per-tile edge profiles from the art.
// For every tiles/<cat>/tile_NN.png, per screen column (0..63):
//   lip[x]    = offset (px, + = lower) of the DRAWN top-face/wall boundary
//               from the analytic diamond edge (rows 21->34->21) — detected by
//               the strongest sustained luminance drop, then regularized.
//   bottom[x] = offset of the DRAWN silhouette bottom from the ideal wall
//               bottom (rows 40->53->40) — from the alpha channel.
// Output: client/public/tile-profiles.json (consumed later by the shader) +
// a self-validation report: the baked lip must separate top (bright) from
// face (dark) BETTER than the analytic edge, or the tile falls back to 0.
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";

const TILES = "/home/user/pixel/tiles";
const OUT = new URL("../client/public/tile-profiles.json", import.meta.url).pathname;
const W = 64, TOP = 8, MID = 21, BOT = 34, WALL = 19;
const BAND = 14; // search window around the analytic edge
const CLAMP = 14; // max |offset| stored

const analyticLip = (x) => BOT - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);
const analyticBot = (x) => BOT + WALL - (Math.abs(x + 0.5 - W / 2) / (W / 2)) * (BOT - MID);

function lum(p, x, y) {
  const i = (y * p.width + x) * 4;
  if (p.data[i + 3] <= 16) return null;
  return 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2];
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Detect the drawn lip per column: strongest sustained shading DISCONTINUITY
 * within the band (3 rows above vs 4 rows below). Either direction — some
 * tiles draw walls darker than the top (meadow), others brighter (grass). */
function detectLip(p) {
  const raw = new Array(W).fill(null);
  for (let x = 0; x < W; x++) {
    const a = analyticLip(x);
    let best = null, bestStep = 8;
    for (let y = Math.max(TOP + 2, Math.round(a - BAND)); y <= Math.min(BOT + WALL - 2, Math.round(a + BAND)); y++) {
      const above = [], below = [];
      for (let k = 1; k <= 3; k++) { const v = lum(p, x, y - k); if (v !== null) above.push(v); }
      for (let k = 1; k <= 4; k++) { const v = lum(p, x, y + k); if (v !== null) below.push(v); }
      if (above.length < 2 || below.length < 3) continue;
      const step = Math.abs(
        above.reduce((s, v) => s + v) / above.length - below.reduce((s, v) => s + v) / below.length,
      );
      if (step > bestStep) { bestStep = step; best = y - a; }
    }
    raw[x] = best;
  }
  // Regularize: fill gaps from neighbours, clamp outliers to a local median,
  // then a 3-wide median pass — keeps raggedness, kills single-column noise.
  const filled = raw.map((v, x) => {
    if (v !== null) return v;
    for (let d = 1; d < W; d++) {
      const l = raw[x - d], r = raw[x + d];
      if (l != null) return l;
      if (r != null) return r;
    }
    return 0;
  });
  const smoothed = filled.map((v, x) => {
    const win = filled.slice(Math.max(0, x - 2), x + 3);
    const m = median(win);
    return Math.abs(v - m) > 5 ? m : v;
  });
  return smoothed.map((v, x) => {
    const win = smoothed.slice(Math.max(0, x - 1), x + 2);
    return Math.max(-CLAMP, Math.min(CLAMP, Math.round(median(win))));
  });
}

/** Drawn silhouette bottom per column from alpha. */
function detectBottom(p) {
  const out = new Array(W).fill(0);
  for (let x = 0; x < W; x++) {
    let lo = -1;
    for (let y = 0; y < p.height; y++) if (p.data[(y * p.width + x) * 4 + 3] > 16) lo = y;
    out[x] = lo < 0 ? 0 : Math.max(-CLAMP, Math.min(CLAMP, Math.round(lo - analyticBot(x))));
  }
  return out;
}

/** Validation: mean luminance separation (top zone minus face zone) when the
 * tile is split at the given lip offsets. Bigger = cleaner split. */
function separation(p, lip) {
  let topSum = 0, topN = 0, faceSum = 0, faceN = 0;
  for (let x = 0; x < W; x++) {
    const edge = analyticLip(x) + (lip ? lip[x] : 0);
    for (let y = TOP; y <= BOT + WALL; y++) {
      const v = lum(p, x, y);
      if (v === null) continue;
      if (y < edge - 1) { topSum += v; topN++; }
      else if (y > edge + 1) { faceSum += v; faceN++; }
    }
  }
  if (!topN || !faceN) return 0;
  return topSum / topN - faceSum / faceN;
}

const rows = []; // per tile: { key, lip[64], bottom[64] }
const report = [];
for (const cat of readdirSync(TILES).sort()) {
  const dir = `${TILES}/${cat}`;
  if (!existsSync(`${dir}/tile_00.png`)) continue;
  for (const f of readdirSync(dir).sort()) {
    const m = f.match(/^tile_(\d+)\.png$/);
    if (!m) continue;
    const p = PNG.sync.read(readFileSync(`${dir}/${f}`));
    if (p.width !== W || p.height !== W) continue;
    const lip = detectLip(p);
    const bottom = detectBottom(p);
    const sepA = separation(p, null);
    const sepP = separation(p, lip);
    // Keep the baked lip only if it splits top/face at least as well as the
    // analytic edge (|separation| — the split contrast, whichever sign the
    // art shades its walls); otherwise no clear lip — fall back to 0.
    const ok = Math.abs(sepP) >= Math.abs(sepA) - 0.5;
    rows.push({ key: `${cat}/${+m[1]}`, lip: ok ? lip : new Array(W).fill(0), bottom });
    report.push({ key: `${cat}/${+m[1]}`, sepA, sepP, ok, lipMean: lip.reduce((a, b) => a + Math.abs(b), 0) / W });
  }
}

// Artifact: a compact PNG (64 x N, one row per tile; R = lip+CLAMP,
// G = bottom+CLAMP, B unused) + a tiny JSON index "cat/variant" -> row.
// This is directly uploadable as a shader lookup texture in stage B2.
const png = new PNG({ width: W, height: rows.length });
const index = {};
rows.forEach((r, row) => {
  index[r.key] = row;
  for (let x = 0; x < W; x++) {
    const i = (row * W + x) * 4;
    png.data[i] = r.lip[x] + CLAMP;
    png.data[i + 1] = r.bottom[x] + CLAMP;
    png.data[i + 2] = 0;
    png.data[i + 3] = 255;
  }
});
writeFileSync(OUT.replace(/\.json$/, ".png"), PNG.sync.write(png));
writeFileSync(OUT, JSON.stringify({ format: "tile-profiles@2", clamp: CLAMP, width: W, rows: rows.length, index }));

const kept = report.filter((r) => r.ok).length;
console.log(`baked ${report.length} tiles -> ${OUT}`);
console.log(`lip kept (better-than-analytic split): ${kept}/${report.length}`);
console.log("== biggest lip corrections (kept) ==");
report.filter((r) => r.ok).sort((a, b) => b.lipMean - a.lipMean).slice(0, 10)
  .forEach((r) => console.log(`  ${r.key.padEnd(26)} |lip| ${r.lipMean.toFixed(1)}px  sep ${r.sepA.toFixed(1)} -> ${r.sepP.toFixed(1)}`));
console.log("== spawn tiles ==");
for (const k of ["meadow/0", "grass/0", "flowers/0", "dirt/0", "forest/0", "water/0"]) {
  const r = report.find((x) => x.key === k);
  if (r) console.log(`  ${k.padEnd(26)} |lip| ${r.lipMean.toFixed(1)}px  sep ${r.sepA.toFixed(1)} -> ${r.sepP.toFixed(1)}  ${r.ok ? "kept" : "FALLBACK 0"}`);
}

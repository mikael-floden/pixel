// Self-emission audit: for every tile category, measure whether the ART
// contains pixel clusters that LOOK emissive — bright AND saturated (HSV
// value*saturation high, or very bright warm/cool hues) — and propose an
// emission entry (color from the emissive pixels' mean, strength/radius from
// coverage). Humans curate the output into tiles/emission.json; most tiles
// must stay dark (playtester direction: don't overuse).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { PNG } from "pngjs";

const TILES = "/home/user/pixel/tiles";

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

function audit(file) {
  const p = PNG.sync.read(readFileSync(file));
  // Emission is LOCAL contrast: pixels that outshine their own tile.
  // A sunlit sand tile is uniformly bright (no outliers); lava has hot
  // spots on dark rock. First pass: the tile's median brightness.
  const vs = [];
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      if (p.data[i + 3] <= 16) continue;
      vs.push(Math.max(p.data[i], p.data[i + 1], p.data[i + 2]) / 255);
    }
  if (!vs.length) return null;
  vs.sort((a, b) => a - b);
  const medV = vs[Math.floor(vs.length / 2)];
  let opaque = 0;
  const glow = []; // [r,g,b] of emissive-looking pixels
  const hues = [];
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const i = (y * p.width + x) * 4;
      if (p.data[i + 3] <= 16) continue;
      opaque++;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      const [h, s, v] = rgbToHsv(r, g, b);
      // "Looks emissive": vividly coloured, bright, AND clearly brighter
      // than the tile's own median (a lit spot on darker material).
      if (s > 0.4 && v > 0.65 && v - medV > 0.28) {
        glow.push([r, g, b]);
        hues.push(h);
      }
    }
  const frac = glow.length / opaque;
  if (!glow.length) return { frac: 0 };
  const mean = glow
    .reduce((a, c) => [a[0] + c[0], a[1] + c[1], a[2] + c[2]], [0, 0, 0])
    .map((v) => Math.round(v / glow.length));
  // Hue concentration: emissive materials glow in ONE colour; scattered hues
  // are just bright texture (flowers, snow highlights).
  hues.sort((a, b) => a - b);
  const medHue = hues[Math.floor(hues.length / 2)];
  const near = hues.filter((h) => Math.min(Math.abs(h - medHue), 360 - Math.abs(h - medHue)) < 35).length / hues.length;
  return { frac, mean, medHue: Math.round(medHue), hueConc: +near.toFixed(2) };
}

const rows = [];
for (const cat of readdirSync(TILES).sort()) {
  const dir = `${TILES}/${cat}`;
  if (!existsSync(`${dir}/tile_00.png`)) continue;
  // Merge across up to 4 variants for a stable read.
  let agg = { frac: 0, mean: [0, 0, 0], hueConc: 0, medHue: 0, n: 0 };
  for (const f of readdirSync(dir).filter((f) => /^tile_\d+\.png$/.test(f)).slice(0, 4)) {
    const a = audit(`${dir}/${f}`);
    if (!a) continue;
    agg.frac += a.frac;
    agg.n++;
    if (a.mean) {
      agg.mean = agg.mean.map((v, k) => v + a.mean[k]);
      agg.hueConc += a.hueConc;
      agg.medHue = a.medHue;
    }
  }
  if (!agg.n) continue;
  const frac = agg.frac / agg.n;
  const mean = agg.mean.map((v) => Math.round(v / agg.n));
  rows.push({ cat, frac: +(frac * 100).toFixed(1), mean, medHue: agg.medHue, hueConc: +(agg.hueConc / agg.n).toFixed(2) });
}
rows.sort((a, b) => b.frac - a.frac);
console.log("category                     glow%  hueConc  medHue  meanRGB");
for (const r of rows.slice(0, 40))
  console.log(
    `${r.cat.padEnd(28)} ${String(r.frac).padStart(5)}  ${String(r.hueConc).padStart(6)}  ${String(r.medHue).padStart(5)}  ${r.mean.join(",")}`,
  );

// Per-pixel emission analyzer (tile-emission@2).
//
// For every EMISSIVE category (curated in tiles/emission.json) this walks every
// variant PNG and extracts the exact glowing pixel clusters:
//   { x, y (image px, cluster centroid), r (px), color (the cluster's OWN
//     colour — a tile can mix gold nuggets and blue crystals), s (strength),
//     dir ("up" = on the top diamond / object art above the block,
//          "sw" = on the left face, "se" = on the right face) }
// The game stamps a localized glow halo at each source (see nightlight.ts):
// several light sources per tile, centred exactly on the glowing art, glowing
// in the direction the art faces. Curated per-category fields (color/strength/
// radius/anim/self) stay untouched — they drive the cell floor + big pools.
//
// Detection: vivid pixels that outshine their own tile (local contrast), plus
// a "molten" rule for warm materials where the whole surface IS the light.
// Geometry: per-tile apex_y/base_y from tiles/<cat>/tiles.json anchor the top
// diamond (26px tall from the apex); pixels below it split sw/se at x=32.
//
// Usage: node scripts/analyze-emission.mjs [--overlays DIR]
//   --overlays writes 4x debug PNGs with circles (green=up orange=sw cyan=se)
//   so a human/agent can verify placement against the art.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { PNG } from "pngjs";

const TILES = "/home/user/pixel/tiles";
const EMISSION = `${TILES}/emission.json`;
const MAX_SOURCES = 10; // per tile variant (keep the brightest)
const DIAMOND_H = 26; // top diamond height at 64px footprint

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
const hueDist = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

function analyzeTile(file, entry, apexY, isObject) {
  const p = PNG.sync.read(readFileSync(file));
  const W = p.width, H = p.height;
  const at = (x, y) => {
    const i = (y * W + x) * 4;
    return { r: p.data[i], g: p.data[i + 1], b: p.data[i + 2], a: p.data[i + 3] };
  };
  // Tile median brightness (opaque pixels) — the local-contrast baseline —
  // plus the opaque bbox (object-art direction rule needs it).
  const vs = [];
  let artTop = H, artBot = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const q = at(x, y);
      if (q.a > 16) {
        vs.push(Math.max(q.r, q.g, q.b) / 255);
        if (y < artTop) artTop = y;
        if (y > artBot) artBot = y;
      }
    }
  if (!vs.length) return { sources: [], coverage: 0 };
  vs.sort((a, b) => a - b);
  const medV = vs[Math.floor(vs.length / 2)];

  // Region of a pixel — the top DIAMOND is a rhombus, not a y-band: its lower
  // edge runs from (centre, apex+26) up to (sides, apex+13). Everything on or
  // above that edge (incl. object art above the apex) emits UP; below it, the
  // left half is the sw face, the right half the se face. A flat y threshold
  // put side-face pixels near the corners in "up" and draped ledge tops in
  // the faces (verified by the overlay review).
  // OBJECT tiles (spires…) are not blocks — their crowns emit UP and the
  // lower body splits sw/se at the drawn art's 40% height line.
  const region = (x, y) => {
    if (isObject) return y <= artTop + (artBot - artTop) * 0.4 ? "up" : x < W / 2 ? "sw" : "se";
    const t = Math.abs(x + 0.5 - W / 2) / (W / 2);
    return y <= apexY + DIAMOND_H - t * (DIAMOND_H / 2) + 2 ? "up" : x < W / 2 ? "sw" : "se";
  };

  // Glow mask — per-pixel rules stay LOOSE; the real filtering happens at
  // cluster level where colour/shape statistics are meaningful.
  //   outlier: vivid pixels that outshine their own tile (crystals, gems);
  //   moltenRed: saturated hot-red/orange — lava is the light even when the
  //     whole tile is molten (no outliers on uniform lava);
  //   goldHot: bright saturated yellow-gold (nuggets/veins), threshold high
  //     enough to exclude tan dirt, wood and sacks;
  //   whiteHot: near-white blown-out cores (pale crystal/ice spires).
  const mask = new Uint8Array(W * H);
  let glowing = 0, opaque = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const q = at(x, y);
      if (q.a <= 16) continue;
      opaque++;
      const [h, s, v] = rgbToHsv(q.r, q.g, q.b);
      // Warm tans (dirt/wood) are numerically saturated — the warm band gets
      // NO generic-outlier path, only the bright goldHot rule (otherwise a
      // sandy summit merges with its nuggets into one dead mega-cluster).
      const outlier = s > 0.4 && v > 0.55 && v - medV > 0.18 && !(h >= 15 && h < 70);
      const moltenRed = (h < 25 || h > 330) && s > 0.6 && v > 0.55;
      const goldHot = h >= 20 && h < 70 && s > 0.55 && v > 0.72;
      const whiteHot = s < 0.3 && v > 0.85 && v - medV > 0.3;
      if (outlier || moltenRed || goldHot || whiteHot) {
        mask[y * W + x] = 1;
        glowing++;
      }
    }

  // Connected components PER REGION (8-conn): a molten blob spanning top and
  // faces must yield separate up/sw/se sources — merged, its centroid landed
  // on the top and the faces got no light at all.
  const seen = new Uint8Array(W * H);
  const clusters = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i0 = y * W + x;
      if (!mask[i0] || seen[i0]) continue;
      const reg = region(x, y);
      const stack = [i0];
      seen[i0] = 1;
      const px = [];
      while (stack.length) {
        const i = stack.pop();
        px.push(i);
        const cx = i % W, cy = (i / W) | 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const j = ny * W + nx;
            if (mask[j] && !seen[j] && region(nx, ny) === reg) {
              seen[j] = 1;
              stack.push(j);
            }
          }
      }
      if (px.length >= 3) clusters.push({ px, reg });
    }

  // Cluster stats → vetoes → source.
  const sources = clusters
    .map(({ px, reg }) => {
      let sx = 0, sy = 0, lum = 0, sS = 0, sV = 0;
      let x0 = W, x1 = 0, y0 = H, y1 = 0;
      const cols = [];
      for (const i of px) {
        const x = i % W, y = (i / W) | 0;
        const q = at(x, y);
        const [, s, v] = rgbToHsv(q.r, q.g, q.b);
        sx += x; sy += y; lum += v; sS += s; sV += v;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        cols.push({ r: q.r, g: q.g, b: q.b, v: v * (0.5 + s) });
      }
      const n = px.length;
      const meanS = sS / n, meanV = sV / n;
      cols.sort((a, b) => b.v - a.v);
      const top = cols.slice(0, Math.max(1, cols.length >> 2));
      let cr = 0, cg = 0, cb = 0;
      for (const c of top) { cr += c.r; cg += c.g; cb += c.b; }
      cr /= top.length; cg /= top.length; cb /= top.length;
      const [ch] = rgbToHsv(cr, cg, cb);
      const mx = Math.max(cr, cg, cb, 1);
      // Core stats: a LARGE emitter's mean is diluted by its shaded skirt —
      // judge big clusters by their bright quartile, or the vetoes tuned for
      // small scraps kill whole crystal columns (round-2 regression).
      let coreS = 0, coreV = 0;
      for (const c of top) {
        const [, s2, v2] = rgbToHsv(c.r, c.g, c.b);
        coreS += s2; coreV += v2;
      }
      coreS /= top.length; coreV /= top.length;
      const bigVivid = n >= 40 && coreV > 0.75 && coreS > 0.45;
      // Minimum mass: 5px in general, but VIVID bright fragments count from
      // 3px — a lantern's glass panes split by their frame died at min-5.
      if (n < 5 && !(meanS > 0.6 && meanV > 0.8)) return null;

      // Cluster vetoes (from the overlay review's systematic false positives):
      // 1. Thin dull LINES: anti-aliased block outlines, specular rims and
      //    seam highlights are line-shaped AND muted; genuine crack networks
      //    (lava, glowing ice) are line-shaped but VIVID — keep those.
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const fill = n / (bw * bh);
      if (!bigVivid) {
        // Hue-based vetoes are meaningless on DESATURATED clusters (a
        // near-white pixel's residual hue reads ~45 "tan" and killed whole
        // pale-crystal spires): pale clusters live or die on brightness.
        if (meanS < 0.3) {
          // Measured: pale scenery highlights peak at coreV ~0.93; genuine
          // pale emitters (icy/amber spires) blow out at 0.98+. LARGE pale
          // masses that far outshine their own tile (ice-crystal fields,
          // coreV−medV ≥ 0.45) are emitters too — small pale debris is not.
          if (!(coreV >= 0.96 || (n >= 40 && coreV >= 0.88 && coreV - medV >= 0.45))) return null;
        } else {
        const lineShaped = fill < 0.3 && Math.max(bw, bh) >= 12;
        if (lineShaped && (meanS < 0.5 || meanV < 0.62)) return null;
        //  …and AXIS-ALIGNED thin lines (vertical/horizontal rims fill their
        //  bbox, so the fill test misses them): muted straight rims are
        //  specular edges, vivid ones (glowing ice cracks) stay.
        if (Math.min(bw, bh) <= 3 && Math.max(bw, bh) >= 10 && meanS < 0.58) return null;
        //  …and small sparse muted scatters (broken rim fragments). Warm-red
        //  is exempt: dim ember scatter on lava is genuine.
        if (fill < 0.28 && meanS < 0.5 && !(ch < 25 || ch > 330)) return null;
        // 2. Vegetation greens (moss, grass rims): dull green is scenery; a
        //    genuinely glowing green crystal is far brighter.
        if (ch > 65 && ch < 165 && meanV < 0.75) return null;
        // 2b. Muted cool lavenders: obsidian seam/rim highlights read as
        //     faint purple — real crystal is saturated OR blazing bright.
        if (ch >= 200 && ch <= 330 && meanS <= 0.52 && meanV < 0.8) return null;
        // 3. Warm tans (dirt, wood, sacks, roots, puffballs): the gold band
        //    needs BOTH high saturation and near-full brightness.
        if (ch >= 15 && ch < 70 && (meanS < 0.55 || meanV < 0.72)) return null;
        // 4. Dark DULL scraps: outline/base fragments that slip the mask.
        //    Saturated-but-face-shaded emitters (cyan caps on a wall) stay.
        if (meanV < 0.55 && meanS < 0.6 && !(ch < 25 || ch > 330)) return null;
        }
      }

      const cx = sx / n, cy = sy / n;
      return {
        x: +cx.toFixed(1),
        y: +cy.toFixed(1),
        r: +Math.min(20, Math.max(2, Math.sqrt(n / Math.PI) * 1.6 + 1.5)).toFixed(1),
        color: [+(cr / mx).toFixed(2), +(cg / mx).toFixed(2), +(cb / mx).toFixed(2)],
        s: +Math.min(1, 0.3 + meanV * 0.7).toFixed(2),
        dir: reg,
        n,
        lum,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.lum - a.lum);
  // Region diversity: a tile crowded with bright top clusters must not starve
  // its face sources below the cap — swap each region's best back in.
  let picked = sources.slice(0, MAX_SOURCES);
  // Collect ALL missing regions first, then displace that many of the
  // DIMMEST non-rescued picks — replacing picked[last] per-region evicted
  // the previous rescue when two regions were missing at once.
  const rescues = ["up", "sw", "se"]
    .filter((reg) => sources.some((s) => s.dir === reg) && !picked.some((s) => s.dir === reg))
    .map((reg) => sources.find((s) => s.dir === reg));
  if (rescues.length) {
    picked = picked.slice(0, Math.max(0, picked.length - rescues.length)).concat(rescues);
    picked.sort((a, b) => b.lum - a.lum);
  }
  return { sources: picked.map(({ n, lum, ...s }) => s), coverage: glowing / opaque, W, H, png: p, mask };
}

function drawOverlay(res, sources, outFile) {
  const S = 4;
  const o = new PNG({ width: res.W * S, height: res.H * S });
  for (let y = 0; y < res.H * S; y++)
    for (let x = 0; x < res.W * S; x++) {
      const si = (((y / S) | 0) * res.W + ((x / S) | 0)) * 4;
      const di = (y * o.width + x) * 4;
      for (let k = 0; k < 4; k++) o.data[di + k] = res.png.data[si + k];
      // dim non-glow pixels so the mask itself is visible
      if (!res.mask[((y / S) | 0) * res.W + ((x / S) | 0)] && o.data[di + 3] > 16) {
        o.data[di] = o.data[di] * 0.55;
        o.data[di + 1] = o.data[di + 1] * 0.55;
        o.data[di + 2] = o.data[di + 2] * 0.55;
      }
    }
  const DIR_COL = { up: [40, 255, 60], sw: [255, 150, 30], se: [40, 220, 255] };
  for (const s of sources) {
    const [cr, cg, cb] = DIR_COL[s.dir];
    const cx = s.x * S, cy = s.y * S, rad = Math.max(s.r * S, 6);
    for (let a = 0; a < 360; a += 2) {
      const x = Math.round(cx + Math.cos((a * Math.PI) / 180) * rad);
      const y = Math.round(cy + Math.sin((a * Math.PI) / 180) * rad);
      if (x < 0 || y < 0 || x >= o.width || y >= o.height) continue;
      const i = (y * o.width + x) * 4;
      o.data[i] = cr; o.data[i + 1] = cg; o.data[i + 2] = cb; o.data[i + 3] = 255;
    }
  }
  writeFileSync(outFile, PNG.sync.write(o));
}

const overlayDir = process.argv.includes("--overlays")
  ? process.argv[process.argv.indexOf("--overlays") + 1]
  : null;
if (overlayDir) mkdirSync(overlayDir, { recursive: true });

const reg = JSON.parse(readFileSync(EMISSION, "utf8"));
let totalSources = 0, totalTiles = 0;
for (const [cat, entry] of Object.entries(reg.categories)) {
  if (!entry) continue;
  const dir = `${TILES}/${cat}`;
  const meta = existsSync(`${dir}/tiles.json`) ? JSON.parse(readFileSync(`${dir}/tiles.json`, "utf8")) : null;
  const apexFor = (idx) => meta?.tiles?.[idx]?.apex_y ?? meta?.geometry?.apex_y ?? 8;
  const files = readdirSync(dir).filter((f) => /^tile_\d+\.png$/.test(f)).sort();
  const sources = {};
  const covs = [];
  for (const f of files) {
    const idx = parseInt(f.match(/\d+/)[0], 10);
    const res = analyzeTile(`${dir}/${f}`, entry, apexFor(idx), /spire/.test(cat));
    covs.push(res.coverage);
    if (res.sources.length) {
      sources[String(idx)] = res.sources;
      totalSources += res.sources.length;
    }
    totalTiles++;
    if (overlayDir && res.png) drawOverlay(res, res.sources, `${overlayDir}/${cat}_${String(idx).padStart(2, "0")}.png`);
  }
  entry.sources = sources;
  entry.variants = files.length; // so consumers can enumerate even sourceless variants
  const cov = covs.reduce((a, b) => a + b, 0) / (covs.length || 1);
  const dirs = {};
  for (const arr of Object.values(sources)) for (const s of arr) dirs[s.dir] = (dirs[s.dir] || 0) + 1;
  console.log(
    `${cat.padEnd(18)} variants ${files.length}, sources ${Object.values(sources).reduce((a, c) => a + c.length, 0)}, coverage ${(cov * 100).toFixed(1)}%, dirs ${JSON.stringify(dirs)}`,
  );
}

reg.format = "tile-emission@2";
reg.doc =
  "Self-emission registry v2: WHICH tile categories glow and WHERE, per pixel. Consumed by games (nangijala night shader). EVERY category has an entry: null = audited, does not glow. Category fields drive the cell-wide night behaviour: color [r,g,b] 0..1, strength (pool intensity), radius (pool size, cells), anim static|flicker|pulse, self 0..1 (how much the tile's own pixels resist darkness). NEW in @2: sources — per VARIANT ('0'..'15'), the exact glowing pixel clusters as {x,y (image px), r (px), color (the cluster's OWN colour), s (strength 0..1), dir up|sw|se (top diamond / left face / right face)}. The game stamps a localized halo per source, so one tile can carry several lights, each centred on its glowing art and glowing the way the art faces. Generated by games/nangijala/scripts/analyze-emission.mjs — RE-RUN IT after art changes; hand-edit only category-level fields. TILES AGENT: when generating a NEW category, add its entry here (usually null) in the same commit.";
writeFileSync(EMISSION, JSON.stringify(reg, null, 2) + "\n");
console.log(`\nwrote ${EMISSION}: ${totalSources} sources across ${totalTiles} tiles${overlayDir ? `, overlays in ${overlayDir}` : ""}`);

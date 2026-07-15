// Cut the HUD concept art (maintainer-provided mockups) into the UI tiles the
// client uses (client/public/ui/): ornate frame corner, repeatable rails,
// edge-centre gem medallions, the 3-state button plate (9-sliceable) and the
// five tab icons. One-shot tool — the source mockups live outside the repo:
//   node scripts/build-ui-tiles.mjs <concept.png> <states.png> [outDir]
// Concept geometry (848x1264): outer frame box at inset 26, rail band 24px,
// filigree corner ~130px, gems centred at x=424 (top, blue) / y=410 (left,
// green). Tiles are keyed transparent by flood-filling the BACKGROUND from
// the crop border — icons keep their interior greys (helmet/gear are grey on
// grey; colour keying alone would eat them).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

const [srcConcept, srcStates, outDir = "client/public/ui"] = process.argv.slice(2);
if (!srcConcept || !srcStates) {
  console.error("usage: node scripts/build-ui-tiles.mjs <concept.png> <states.png> [outDir]");
  process.exit(1);
}
const c1 = PNG.sync.read(readFileSync(srcConcept));
const c2 = PNG.sync.read(readFileSync(srcStates));
mkdirSync(outDir, { recursive: true });

function crop(src, x0, y0, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = ((y0 + y) * src.width + (x0 + x)) * 4;
      const q = (y * w + x) * 4;
      for (let i = 0; i < 4; i++) out.data[q + i] = src.data[p + i];
    }
  return out;
}

/** Flood the background transparent starting from every border pixel that
 * matches `isBg`; the fill spreads only through matching pixels, so outlined
 * art survives untouched. */
function keyBackground(img, isBg) {
  const { width: w, height: h, data } = img;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (!seen[i] && isBg(data, i * 4)) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) push(nx, ny);
      }
  }
  for (let i = 0; i < w * h; i++) if (seen[i]) data[i * 4 + 3] = 0;
  return img;
}

// Navy/black page bg incl. its AA halo — but never the art's warm dark
// outlines (vine browns have r well above g).
const darkBg = (d, o) => d[o] < 70 && d[o + 1] < 70 && d[o + 2] < 95 && d[o] <= d[o + 1] + 25;
// Steel plate fill: light-to-mid desaturated grey gradient (icons are either
// coloured or grey WITH a near-black outline the flood cannot cross).
const plateBg = (d, o) => {
  const [r, g, b] = [d[o], d[o + 1], d[o + 2]];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx - mn < 26 && mn > 62 && mx < 205;
};
// Selected (backpack) plate fill: steel blue gradient.
const blueBg = (d, o) => {
  const [r, g, b] = [d[o], d[o + 1], d[o + 2]];
  return b > r + 12 && b > 70 && g > r - 10 && r < 150;
};

/** Remove tiny opaque islands left around the art after keying (the mock's
 * anti-aliasing crumbs read as floating dirt over the game world at 2x). */
function dropSpecks(img, minSize = 40) {
  const { width: w, height: h, data } = img;
  const lab = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    if (lab[i] >= 0 || data[i * 4 + 3] === 0) continue;
    const stack = [i];
    const members = [];
    lab[i] = i;
    while (stack.length) {
      const j = stack.pop();
      members.push(j);
      const x = j % w;
      const y = (j / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const k = ny * w + nx;
          if (lab[k] < 0 && data[k * 4 + 3] > 0) {
            lab[k] = i;
            stack.push(k);
          }
        }
    }
    if (members.length < minSize) for (const j of members) data[j * 4 + 3] = 0;
  }
  return img;
}

const save = (name, img) => {
  writeFileSync(join(outDir, name), PNG.sync.write(img));
  console.log(`  ${name} ${img.width}x${img.height}`);
};

// ---- frame pieces (concept, image 1) ---------------------------------------
// PIXEL-PERFECT JOINTS BY CONSTRUCTION (maintainer round 3): the mock's rails
// are thin hand-drawn lines that MEANDER a few px across the page (measured:
// top gold 38..44, divider A 707..711, divider B slopes 878→882, bottom
// 1234..1238), so tiling one repeating sample can never meet the corner arms
// cleanly. Instead the frame is cut as SEGMENTS between junctions, in
// mock-ABSOLUTE coordinates, and the client stretches only the segment
// interiors — every joint then shares identical adjacent mock pixels.
// NOTHING is mirrored (per-side lighting differs).
//
// Keying policy: everything OUTSIDE the border must stay opaque black (the
// game view must not leak past the frame), so outer-border pieces flood only
// from their INNER side; divider pieces flood from all edges (both sides are
// interior). Every piece gets a 1-ART-PIXEL border ring baked in (see
// pieceArt()) — the border is part of the frame pixel art, on the same 4px
// grid, not a CSS-smooth halo (maintainer round 6).

// ART-RESOLUTION REBUILD (maintainer round 9: "the original is way more
// clean"): the earlier per-pixel snapping filled block remainders with
// nearest-AA-blend colours and promoted soft fringe into mud-brown halo
// blocks the original never had. So each tile is now rebuilt as GENUINE
// art-resolution pixel art and scaled 4x nearest-neighbour: every 4px grid
// cell of the mock becomes exactly ONE flat colour — the DOMINANT colour
// cluster of its 16 source pixels (never an average across clusters, so a
// cell is clean navy or clean gold, not a blend) — classification, keying,
// erasing and the border ring all happen at that block resolution, and the
// emitted PNG just paints each block solid. Blocks live on the mock-GLOBAL
// grid so joints between pieces stay pixel-identical.

const isBgCol = (r, g, b) => r < 70 && g < 70 && b < 95 && r <= g + 25;

/** Dominant colour of a pixel list: cluster by coarse RGB bins (>>5) and
 * average the winning cluster's members only — never blend across clusters,
 * so a cell comes out clean navy or clean gold, not mud. ART BIAS: a sizable
 * non-background cluster (≥5 of 16 px) beats a bigger navy cluster —
 * otherwise the mock's soft-brushed gold detail, spread across cell borders,
 * loses the plurality vote everywhere and the filigree erodes. */
function dominant(c, pts) {
  const bins = new Map();
  for (const [x, y] of pts) {
    const o = (y * c.width + x) * 4;
    const k = ((c.data[o] >> 5) << 6) | ((c.data[o + 1] >> 5) << 3) | (c.data[o + 2] >> 5);
    let b = bins.get(k);
    if (!b) bins.set(k, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n++;
    b.r += c.data[o];
    b.g += c.data[o + 1];
    b.b += c.data[o + 2];
  }
  let best = null;
  let bestArt = null;
  for (const b of bins.values()) {
    if (!best || b.n > best.n) best = b;
    // bias only BRIGHT art (the gold filigree the plurality vote erodes) —
    // biasing dark-rust AA minorities too widened the rust band beyond the
    // mock's.
    const bright = Math.max(b.r, b.g, b.b) / b.n >= 110;
    if (bright && !isBgCol(b.r / b.n, b.g / b.n, b.b / b.n) && (!bestArt || b.n > bestArt.n)) bestArt = b;
  }
  const win = bestArt && bestArt.n >= 5 ? bestArt : best;
  return [Math.round(win.r / win.n), Math.round(win.g / win.n), Math.round(win.b / win.n)];
}

// Border ring appearance (maintainer): keep 85% of the colour the ring
// paints over (the page navy) + 15% black, then show at 65% alpha.
const RING_KEEP = 0.85;
const RING_ALPHA = 166;

/** Cut one frame piece as art-resolution pixel art (see block comment).
 * (px0,py0,pw,ph): mock-absolute crop. sides: flood seeds — edge names or
 * crop-relative px regions [x0,y0,x1,y1]. erasers: crop-relative px rects
 * whose blocks are forced transparent (mock button-glow bleed). */
function pieceArt(px0, py0, pw, ph, sides, erasers = []) {
  const G = 4;
  const bx0 = Math.floor(px0 / G);
  const by0 = Math.floor(py0 / G);
  const bw = Math.ceil((px0 + pw) / G) - bx0;
  const bh = Math.ceil((py0 + ph) / G) - by0;
  // 1) downsample: dominant colour per GLOBAL block (sampled straight from
  // the mock, beyond crop bounds too, so edge blocks match the neighbour
  // piece's colours exactly).
  const col = new Uint8Array(bw * bh * 3);
  const isBg = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const pts = [];
      for (let y = (by0 + by) * G; y < (by0 + by + 1) * G; y++)
        for (let x = (bx0 + bx) * G; x < (bx0 + bx + 1) * G; x++)
          if (x >= 0 && y >= 0 && x < c1.width && y < c1.height) pts.push([x, y]);
      const [r, g, b] = dominant(c1, pts);
      const i = by * bw + bx;
      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;
      isBg[i] = isBgCol(r, g, b) ? 1 : 0;
    }
  // 2) flood-key page-bg blocks from the seeds. 4-CONNECTED on purpose: the
  // filigree's own dark navy detail px (checker counterparts, curl insides)
  // touch the open page only diagonally, and an 8-connected flood leaked
  // through those gaps and washed the art's dark detail out to 65%-alpha
  // ring — 4-connectivity against 8-connected art keeps enclosed detail
  // opaque (digital-topology duality).
  const keyed = new Uint8Array(bw * bh);
  const stack = [];
  const push = (bx, by) => {
    if (bx < 0 || by < 0 || bx >= bw || by >= bh) return;
    const i = by * bw + bx;
    if (!keyed[i] && isBg[i]) {
      keyed[i] = 1;
      stack.push(i);
    }
  };
  const seedBlock = (px, py) => push(Math.floor((px0 + px) / G) - bx0, Math.floor((py0 + py) / G) - by0);
  for (const s of sides) {
    if (s === "top") for (let x = 0; x < bw; x++) push(x, 0);
    if (s === "bottom") for (let x = 0; x < bw; x++) push(x, bh - 1);
    if (s === "left") for (let y = 0; y < bh; y++) push(0, y);
    if (s === "right") for (let y = 0; y < bh; y++) push(bw - 1, y);
    if (Array.isArray(s)) for (let y = s[1]; y < s[3]; y += G) for (let x = s[0]; x < s[2]; x += G) seedBlock(x, y);
  }
  while (stack.length) {
    const i = stack.pop();
    const bx = i % bw;
    const by = (i / bw) | 0;
    push(bx - 1, by);
    push(bx + 1, by);
    push(bx, by - 1);
    push(bx, by + 1);
  }
  // 3) erase mock bleed: block transparent, ring colour falls back to the
  // page navy (the bleed colour must not tint the border).
  const erased = new Uint8Array(bw * bh);
  for (const [ex0, ey0, ex1, ey1] of erasers)
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        const cx = (bx0 + bx) * G + G / 2 - px0;
        const cy = (by0 + by) * G + G / 2 - py0;
        if (cx >= ex0 && cx < ex1 && cy >= ey0 && cy < ey1) {
          keyed[by * bw + bx] = 1;
          erased[by * bw + bx] = 1;
        }
      }
  // page navy = dominant over this piece's keyed bg blocks (for erased ring
  // blocks + a stable ring base).
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pn = 0;
  for (let i = 0; i < bw * bh; i++)
    if (keyed[i] && !erased[i]) {
      pr += col[i * 3];
      pg += col[i * 3 + 1];
      pb += col[i * 3 + 2];
      pn++;
    }
  const page = pn ? [pr / pn, pg / pn, pb / pn] : [24, 26, 44];
  // 4) ring: keyed blocks 8-touching a surviving (opaque) block.
  const ring = new Uint8Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const i = by * bw + bx;
      if (!keyed[i]) continue;
      let adj = false;
      for (let dy = -1; dy <= 1 && !adj; dy++)
        for (let dx = -1; dx <= 1 && !adj; dx++) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx >= 0 && ny >= 0 && nx < bw && ny < bh && !keyed[ny * bw + nx]) adj = true;
        }
      if (adj) ring[i] = 1;
    }
  // 5) emit the crop-sized tile: each px paints its block flat.
  const out = new PNG({ width: pw, height: ph });
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const bi = (Math.floor((py0 + y) / G) - by0) * bw + (Math.floor((px0 + x) / G) - bx0);
      const o = (y * pw + x) * 4;
      if (ring[bi]) {
        const src = erased[bi] ? page : [col[bi * 3], col[bi * 3 + 1], col[bi * 3 + 2]];
        out.data[o] = Math.round(src[0] * RING_KEEP);
        out.data[o + 1] = Math.round(src[1] * RING_KEEP);
        out.data[o + 2] = Math.round(src[2] * RING_KEEP);
        out.data[o + 3] = RING_ALPHA;
      } else if (keyed[bi]) {
        out.data[o + 3] = 0;
      } else {
        out.data[o] = col[bi * 3];
        out.data[o + 1] = col[bi * 3 + 1];
        out.data[o + 2] = col[bi * 3 + 2];
        out.data[o + 3] = 255;
      }
    }
  return out;
}

const piece = (x, y, w, h, sides, erasers) => pieceArt(x, y, w, h, sides, erasers);

// Corners: mock-absolute 180px tiles; flood only from the INNER quadrant so
// the outside of the border stays opaque black.
save("corner-tl.png", piece(0, 0, 180, 180, [[140, 140, 180, 180]]));
save("corner-tr.png", piece(668, 0, 180, 180, [[0, 140, 40, 180]]));
save("corner-bl.png", piece(0, 1084, 180, 180, [[140, 0, 180, 40]]));
save("corner-br.png", piece(668, 1084, 180, 180, [[0, 0, 40, 40]], [[20, 20, 110, 110]]));
// Top border between the corners (filigree verified to stop by x=180, so
// these are clean rail): stretch-segments + the fixed gem piece.
save("top-seg-l.png", piece(180, 0, 216, 76, ["bottom"]));
save("gem-top.png", piece(396, 0, 56, 76, ["bottom"]));
save("top-seg-r.png", piece(452, 0, 216, 76, ["bottom"]));
save("bottom-seg.png", piece(180, 1188, 488, 76, ["top"]));
// Side borders: SEGMENTS BETWEEN JUNCTIONS ONLY (maintainer round 4: the old
// full-height strip baked the divider-junction decor at mock positions and
// stretched it into unrecognisable smears — junction art lives ONLY in the
// caps now, and each clean-rail segment maps to its page span):
//   v1 corner→gem, v2 gem→divA cap, v3 between the dividers (rail beside the
//   tabs; the mock buttons' glow column x≥52 erased), v4 divB cap→corner.
save("left-v1.png", piece(0, 180, 56, 196, ["right"]));
save("gem-left.png", piece(0, 376, 76, 68, ["right"]));
save("left-v2.png", piece(0, 444, 56, 196, ["right"]));
save("left-v3.png", piece(0, 740, 56, 122, ["right"], [[52, 0, 56, 122]]));
save("left-v4.png", piece(0, 918, 56, 166, ["right"]));
save("right-v1.png", piece(792, 180, 56, 196, ["left"]));
save("gem-right.png", piece(772, 376, 76, 68, ["left"]));
save("right-v2.png", piece(792, 444, 56, 196, ["left"]));
save("right-v3.png", piece(792, 740, 56, 122, ["left"], [[0, 0, 4, 122]]));
save("right-v4.png", piece(792, 918, 56, 166, ["left"]));
// Divider A (game ↔ tabs; thin line 707..711). WIDE caps (190px) own ALL the
// junction decor — the ╠/╣ green gems and the curls that run along the line
// to x≈190; the mock button row's pixels (y≥728, glow column x≥52) erased.
save("divA-capl.png", piece(0, 640, 190, 100, ["right"], [[52, 82, 190, 100]]));
save("divA-seg-l.png", piece(190, 688, 206, 36, ["top", "bottom"]));
save("divA-gem.png", piece(396, 674, 56, 58, ["top", "bottom", "left", "right"]));
save("divA-seg-r.png", piece(452, 688, 206, 36, ["top", "bottom"]));
save("divA-capr.png", piece(848 - 190, 640, 190, 100, ["left"], [[0, 82, 138, 100]]));
// Divider B (tabs ↔ content; thin sloping line, no gem): wide caps with the
// button-bottom bleed erased (x≥52 / mirrored, top 16 rows).
save("divB-capl.png", piece(0, 862, 190, 56, ["right"], [[52, 0, 190, 16]]));
save("divB-seg.png", piece(190, 872, 468, 16, ["top", "bottom"]));
save("divB-capr.png", piece(848 - 190, 862, 190, 56, ["left"], [[0, 0, 138, 16]]));

// ---- button plates (states, image 2) ---------------------------------------
// Bounds auto-detected: within each square's row band, find the columns/rows
// that differ from the navy page background.
function plateBounds(img, x0, x1, y0, y1) {
  const { width: w, data } = img;
  const bright = (x, y) => {
    const o = (y * w + x) * 4;
    return data[o] + data[o + 1] + data[o + 2] > 190;
  };
  // A row/column belongs to the plate only when MANY pixels light up — the
  // page's small decorative sparkles must not stretch the bounds.
  const MIN = 40;
  let L = -1, R = -1, T = -1, B = -1;
  for (let x = x0; x < x1; x++) {
    let n = 0;
    for (let y = y0; y < y1; y++) if (bright(x, y)) n++;
    if (n >= MIN) {
      if (L < 0) L = x;
      R = x;
    }
  }
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (bright(x, y)) n++;
    if (n >= MIN) {
      if (T < 0) T = y;
      B = y;
    }
  }
  return { x: L, y: T, w: R - L + 1, h: B - T + 1 };
}
const SQ = [
  ["plate-selected.png", 90, 300],
  ["plate-unselected.png", 320, 530],
  ["plate-pressed.png", 550, 760],
];
for (const [name, x0, x1] of SQ) {
  const b = plateBounds(c2, x0, x1, 935, 1155);
  const img = crop(c2, b.x, b.y, b.w, b.h);
  // The mock's decorative page sparkle overlaps the PRESSED plate's
  // bottom-right corner — heal it by mirroring the clean bottom-left corner
  // (the bevel is symmetric).
  if (name === "plate-pressed.png") {
    const { width: w, height: h, data } = img;
    for (let y = h - 46; y < h; y++)
      for (let x = w - 46; x < w; x++) {
        const q = (y * w + x) * 4;
        const p = (y * w + (w - 1 - x)) * 4;
        for (let i = 0; i < 4; i++) data[q + i] = data[p + i];
      }
  }
  save(name, img);
}

// ---- tab icons (concept, image 1 buttons row) -------------------------------
// Tight boxes around each icon (above the label), background flooded away.
const ICONS = [
  ["icon-backpack.png", 72, 744, 104, 74, blueBg],
  ["icon-equipment.png", 232, 748, 84, 70, plateBg],
  ["icon-map.png", 384, 748, 84, 70, plateBg],
  ["icon-settings.png", 534, 746, 86, 74, plateBg],
  ["icon-logout.png", 684, 748, 92, 70, plateBg],
];
for (const [name, x, y, w, h, bg] of ICONS) save(name, keyBackground(crop(c1, x, y, w, h), bg));

console.log(`[ui-tiles] -> ${outDir}`);

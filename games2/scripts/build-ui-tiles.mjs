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
// interior). Every piece then gets a 1-ART-PIXEL black outline baked in (see
// outline()) — the border is part of the frame pixel art, on the same 4px
// grid, not a CSS-smooth halo (maintainer round 6).

/** Flood-key with explicit seed edges; then soften: any remaining dark pixel
 * touching transparency gets partial alpha proportional to its brightness. */
function keyFrom(img, sides) {
  const { width: w, height: h, data } = img;
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (!seen[i] && darkBg(data, i * 4)) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (const s of sides) {
    if (s === "top") for (let x = 0; x < w; x++) push(x, 0);
    if (s === "bottom") for (let x = 0; x < w; x++) push(x, h - 1);
    if (s === "left") for (let y = 0; y < h; y++) push(0, y);
    if (s === "right") for (let y = 0; y < h; y++) push(w - 1, y);
    if (Array.isArray(s)) {
      // seed REGION (inner corner quadrant): [x0,y0,x1,y1]
      for (let y = s[1]; y < s[3]; y++) for (let x = s[0]; x < s[2]; x++) push(x, y);
    }
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
  // Soft edges: dark blend pixels (the mock's AA between art and page) that
  // now border transparency become PARTIALLY transparent instead of crisp.
  const edge = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (data[i * 4 + 3] === 0) continue;
      const mx = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      if (mx >= 90) continue; // real art edges stay crisp pixel art
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++)
        for (let dx = -1; dx <= 1 && !touches; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && data[(ny * w + nx) * 4 + 3] === 0) touches = true;
        }
      if (touches) edge.push([i, Math.max(30, Math.min(255, Math.round(((mx - 14) * 255) / 76)))]);
    }
  for (const [i, a] of edge) data[i * 4 + 3] = a;
  return img;
}

/** Erase a crop-relative rect to transparency (neighbour-button bleed). */
function erase(img, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) img.data[(y * img.width + x) * 4 + 3] = 0;
  return img;
}

/** BLACK OUTLINE, part of the pixel art (maintainer rounds 6-7): the
 * reference mock draws a black border exactly ONE art pixel (= 4 mock px)
 * thick hugging every curl of the filigree, made of the SAME square pixels
 * as the frame art. Painting art-block remainders black made the border read
 * 1-2 px wide depending on where the mock's soft-brushed art edge fell
 * inside a block (maintainer's blue/red-marked screenshot). So the art
 * itself is SNAPPED to the mock's global 4px art grid first (ox/oy = the
 * piece's mock-absolute crop origin, so blocks line up across segment
 * joints): a block at least half opaque becomes a fully solid art block
 * (empty px take the nearest opaque px's colour), anything less is fringe
 * and is erased. The art boundary is then block-crisp, so the black ring of
 * neighbouring blocks is EXACTLY one art pixel wide everywhere. */
function outline(img, ox = 0, oy = 0, alpha = 128) {
  const { width: w, height: h, data } = img;
  const G = 4;
  // First block starts where the GLOBAL 4px grid would cut this crop.
  const bx0 = -(((ox % G) + G) % G);
  const by0 = -(((oy % G) + G) % G);
  const bw = Math.ceil((w - bx0) / G);
  const bh = Math.ceil((h - by0) / G);
  const art = new Uint8Array(bw * bh);
  const pxOf = (bx, by) => {
    const px = [];
    for (let y = Math.max(0, by0 + by * G); y < Math.min(h, by0 + (by + 1) * G); y++)
      for (let x = Math.max(0, bx0 + bx * G); x < Math.min(w, bx0 + (bx + 1) * G); x++)
        px.push([x, y]);
    return px;
  };
  // Pass 1: classify — a block is ART when at least half of it is opaque.
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const px = pxOf(bx, by);
      let n = 0;
      for (const [x, y] of px) if (data[(y * w + x) * 4 + 3] > 120) n++;
      if (n * 4 >= px.length) art[by * bw + bx] = 1;
    }
  // Pass 2: snap the art to the grid — solidify art blocks, erase fringe.
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      const px = pxOf(bx, by);
      if (!art[by * bw + bx]) {
        for (const [x, y] of px) data[(y * w + x) * 4 + 3] = 0;
        continue;
      }
      const solid = px.filter(([x, y]) => data[(y * w + x) * 4 + 3] > 120);
      for (const [x, y] of px) {
        const o = (y * w + x) * 4;
        if (data[o + 3] > 120) {
          data[o + 3] = 255;
          continue;
        }
        let best = 0;
        let bd = Infinity;
        for (const [sx, sy] of solid) {
          const d = Math.max(Math.abs(sx - x), Math.abs(sy - y));
          if (d < bd) {
            bd = d;
            best = (sy * w + sx) * 4;
          }
        }
        data[o] = data[best];
        data[o + 1] = data[best + 1];
        data[o + 2] = data[best + 2];
        data[o + 3] = 255;
      }
    }
  // Pass 3: the outline — every empty block 8-touching an art block. NOT
  // flat black (maintainer round 8): the border pixel keeps 75% of the
  // colour it paints over (keying/erasing only zeroed ALPHA, so the mock's
  // original RGB — usually the navy page — is still in the channel) blended
  // with 25% black, at 50% alpha so half the game world reads through. The
  // blend colour is averaged PER BLOCK so the border stays one flat square
  // art pixel, not a soft gradient.
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      if (art[by * bw + bx]) continue;
      let adj = false;
      for (let dy = -1; dy <= 1 && !adj; dy++)
        for (let dx = -1; dx <= 1 && !adj; dx++) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx >= 0 && ny >= 0 && nx < bw && ny < bh && art[ny * bw + nx]) adj = true;
        }
      if (!adj) continue;
      const px = pxOf(bx, by);
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [x, y] of px) {
        const o = (y * w + x) * 4;
        r += data[o];
        g += data[o + 1];
        b += data[o + 2];
      }
      r = Math.round((r / px.length) * 0.75);
      g = Math.round((g / px.length) * 0.75);
      b = Math.round((b / px.length) * 0.75);
      for (const [x, y] of px) {
        const o = (y * w + x) * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = alpha;
      }
    }
  return img;
}

// Piece cutter: crop at mock-absolute (x,y), key from the given sides, then
// bake the 1-art-pixel outline on the global grid. `post` runs between the
// keying and the outline (erase() of mock bleed must happen first so the
// outline hugs the CLEANED art).
const piece = (x, y, w, h, sides, post = (i) => i) =>
  outline(post(keyFrom(crop(c1, x, y, w, h), sides)), x, y);

// Corners: mock-absolute 180px tiles; flood only from the INNER quadrant so
// the outside of the border stays opaque black.
save("corner-tl.png", piece(0, 0, 180, 180, [[140, 140, 180, 180]]));
save("corner-tr.png", piece(668, 0, 180, 180, [[0, 140, 40, 180]]));
save("corner-bl.png", piece(0, 1084, 180, 180, [[140, 0, 180, 40]]));
save("corner-br.png", piece(668, 1084, 180, 180, [[0, 0, 40, 40]], (i) => erase(i, 20, 20, 110, 110)));
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
save("left-v3.png", piece(0, 740, 56, 122, ["right"], (i) => erase(i, 52, 0, 56, 122)));
save("left-v4.png", piece(0, 918, 56, 166, ["right"]));
save("right-v1.png", piece(792, 180, 56, 196, ["left"]));
save("gem-right.png", piece(772, 376, 76, 68, ["left"]));
save("right-v2.png", piece(792, 444, 56, 196, ["left"]));
save("right-v3.png", piece(792, 740, 56, 122, ["left"], (i) => erase(i, 0, 0, 4, 122)));
save("right-v4.png", piece(792, 918, 56, 166, ["left"]));
// Divider A (game ↔ tabs; thin line 707..711). WIDE caps (190px) own ALL the
// junction decor — the ╠/╣ green gems and the curls that run along the line
// to x≈190; the mock button row's pixels (y≥728, glow column x≥52) erased.
save("divA-capl.png", piece(0, 640, 190, 100, ["right"], (i) => erase(i, 52, 82, 190, 100)));
save("divA-seg-l.png", piece(190, 688, 206, 36, ["top", "bottom"]));
save("divA-gem.png", piece(396, 674, 56, 58, ["top", "bottom", "left", "right"]));
save("divA-seg-r.png", piece(452, 688, 206, 36, ["top", "bottom"]));
save("divA-capr.png", piece(848 - 190, 640, 190, 100, ["left"], (i) => erase(i, 0, 82, 138, 100)));
// Divider B (tabs ↔ content; thin sloping line, no gem): wide caps with the
// button-bottom bleed erased (x≥52 / mirrored, top 16 rows).
save("divB-capl.png", piece(0, 862, 190, 56, ["right"], (i) => erase(i, 52, 0, 190, 16)));
save("divB-seg.png", piece(190, 872, 468, 16, ["top", "bottom"]));
save("divB-capr.png", piece(848 - 190, 862, 190, 56, ["left"], (i) => erase(i, 0, 0, 138, 16)));

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

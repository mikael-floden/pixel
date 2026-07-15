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
// interior). Boundary pixels get soft ALPHA so cuts blend instead of stair-
// stepping (maintainer: "allow alpha to make it look better").

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

// Corners: mock-absolute 180px tiles; flood only from the INNER quadrant so
// the outside of the border stays opaque black.
save("corner-tl.png", keyFrom(crop(c1, 0, 0, 180, 180), [[140, 140, 180, 180]]));
save("corner-tr.png", keyFrom(crop(c1, 668, 0, 180, 180), [[0, 140, 40, 180]]));
save("corner-bl.png", keyFrom(crop(c1, 0, 1084, 180, 180), [[140, 0, 180, 40]]));
save("corner-br.png", erase(keyFrom(crop(c1, 668, 1084, 180, 180), [[0, 0, 40, 40]]), 20, 20, 110, 110));
// Top border between the corners: stretch-segments + the fixed gem (the gem
// column 396..452 is its own unstretched piece, so the diamond stays square).
save("top-seg-l.png", keyFrom(crop(c1, 180, 0, 216, 76), ["bottom"]));
save("gem-top.png", keyFrom(crop(c1, 396, 0, 56, 76), ["bottom"]));
save("top-seg-r.png", keyFrom(crop(c1, 452, 0, 216, 76), ["bottom"]));
save("bottom-seg.png", keyFrom(crop(c1, 180, 1188, 488, 76), ["top"]));
// Side borders: segments above/below each green gem (flex-proportioned by
// their source heights, so the gem lands at the mock's fraction).
save("left-seg-t.png", keyFrom(crop(c1, 0, 180, 76, 196), ["right"]));
save("gem-left.png", keyFrom(crop(c1, 0, 376, 76, 68), ["right"]));
save("left-seg-b.png", erase(keyFrom(crop(c1, 0, 444, 76, 640), ["right"]), 38, 210, 76, 440));
save("right-seg-t.png", keyFrom(crop(c1, 772, 180, 76, 196), ["left"]));
save("gem-right.png", keyFrom(crop(c1, 772, 376, 76, 68), ["left"]));
save("right-seg-b.png", erase(keyFrom(crop(c1, 772, 444, 76, 640), ["left"]), 0, 210, 38, 440));
// Divider A (game ↔ tabs; thin line 707..711 with green ╠/╣ junction gems +
// the blue centre gem). Caps are cropped to 674..740 with the mock button
// row's selected-glow bleed erased (x≥38, y≥44 crop-relative, mirrored).
save("divA-capl.png", erase(keyFrom(crop(c1, 0, 674, 76, 66), ["top", "bottom", "right"]), 38, 44, 76, 66));
save("divA-seg-l.png", keyFrom(crop(c1, 76, 688, 320, 36), ["top", "bottom"]));
save("divA-gem.png", keyFrom(crop(c1, 396, 674, 56, 58), ["top", "bottom", "left", "right"]));
save("divA-seg-r.png", keyFrom(crop(c1, 452, 688, 320, 36), ["top", "bottom"]));
save("divA-capr.png", erase(keyFrom(crop(c1, 772, 674, 76, 66), ["top", "bottom", "left"]), 0, 44, 38, 66));
// Divider B (tabs ↔ content; thin line sloping 878→882, junction curls, no
// gem). Caps erase the mock buttons' bottom bleed (x≥38, y<12).
save("divB-capl.png", erase(keyFrom(crop(c1, 0, 862, 76, 56), ["top", "bottom", "right"]), 38, 0, 76, 16));
save("divB-seg.png", keyFrom(crop(c1, 76, 872, 696, 16), ["top", "bottom"]));
save("divB-capr.png", erase(keyFrom(crop(c1, 772, 862, 76, 56), ["top", "bottom", "left"]), 0, 0, 38, 16));

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

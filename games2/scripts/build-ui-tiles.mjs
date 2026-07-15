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
// NOTHING is mirrored (maintainer): the art's lighting differs per side, so
// every corner, every rail direction and every gem is its own crop, and the
// two horizontal DIVIDERS (game/tabs and tabs/content) are distinct
// assemblies with their own ╠/╣ T-pieces, rail and centre gem. Corners are
// cut generously so they include the transition into the clean repeating
// rail. Bands (from the gold-row scan): top y≈26..50, divider A y≈695..725,
// divider B y≈866..896, bottom y≈1222..1246; left x≈26..50, right x≈798..822.
const CR = 160; // corner crop size — ornament (~130) + transition rail
save("corner-tl.png", dropSpecks(keyBackground(crop(c1, 20, 20, CR, CR), darkBg)));
save("corner-tr.png", dropSpecks(keyBackground(crop(c1, 848 - 20 - CR, 20, CR, CR), darkBg)));
save("corner-bl.png", dropSpecks(keyBackground(crop(c1, 20, 1264 - 20 - CR, CR, CR), darkBg)));
{
  // corner-br: the mock's decorative page sparkle floats in this crop's
  // interior (disconnected from the frame, so the flood can't reach it) —
  // clear the inner quadrant the ornament never reaches.
  const br = dropSpecks(keyBackground(crop(c1, 848 - 20 - CR, 1264 - 20 - CR, CR, CR), darkBg));
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++) br.data[(y * CR + x) * 4 + 3] = 0;
  save("corner-br.png", br);
}
// Outer rails — clean 80px segments per side (distinct lighting).
save("rail-top.png", dropSpecks(keyBackground(crop(c1, 200, 20, 80, 36), darkBg)));
save("rail-bottom.png", dropSpecks(keyBackground(crop(c1, 200, 1264 - 20 - 36, 80, 36), darkBg)));
save("rail-left.png", dropSpecks(keyBackground(crop(c1, 20, 200, 36, 80), darkBg)));
save("rail-right.png", dropSpecks(keyBackground(crop(c1, 848 - 20 - 36, 200, 36, 80), darkBg)));
// Outer gems: top blue + left/right green. (No gem on the outer bottom rail
// or divider B in the mock — verified at pixel level.)
save("gem-top.png", dropSpecks(keyBackground(crop(c1, 396, 0, 56, 72), darkBg)));
save("gem-left.png", dropSpecks(keyBackground(crop(c1, 0, 382, 72, 56), darkBg)));
save("gem-right.png", dropSpecks(keyBackground(crop(c1, 848 - 72, 382, 72, 56), darkBg)));
// Divider A (game ↔ buttons, band ≈695..725): ╠ + rail + centre gem + ╣.
// T-piece/gem crops stop at y=734 — the button row starts right below.
save("divA-left.png", dropSpecks(keyBackground(crop(c1, 0, 670, 84, 56), darkBg)));
save("divA-right.png", dropSpecks(keyBackground(crop(c1, 848 - 84, 670, 84, 56), darkBg)));
save("divA-rail.png", dropSpecks(keyBackground(crop(c1, 200, 694, 80, 32), darkBg)));
save("divA-gem.png", dropSpecks(keyBackground(crop(c1, 396, 674, 56, 52), darkBg)));
// Divider B (buttons ↔ content, band ≈858..880, no gem): ╠ + rail + ╣.
// Crops start at y=856 — the button row's plates end just above.
save("divB-left.png", dropSpecks(keyBackground(crop(c1, 0, 862, 44, 58), darkBg)));
save("divB-right.png", dropSpecks(keyBackground(crop(c1, 848 - 44, 862, 44, 58), darkBg)));
save("divB-rail.png", dropSpecks(keyBackground(crop(c1, 200, 862, 80, 20), darkBg)));

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

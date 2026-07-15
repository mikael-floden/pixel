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
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  for (let i = 0; i < w * h; i++) if (seen[i]) data[i * 4 + 3] = 0;
  return img;
}

const darkBg = (d, o) => d[o] < 40 && d[o + 1] < 40 && d[o + 2] < 55; // navy/black page
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

const save = (name, img) => {
  writeFileSync(join(outDir, name), PNG.sync.write(img));
  console.log(`  ${name} ${img.width}x${img.height}`);
};

// ---- frame pieces (concept, image 1) ---------------------------------------
// One corner + one rail per axis; the client mirrors them for the other
// corners/edges so the rail bands always align seam-free.
save("frame-corner.png", keyBackground(crop(c1, 26, 26, 130, 130), darkBg));
save("frame-rail-h.png", keyBackground(crop(c1, 192, 26, 80, 24), darkBg));
save("frame-rail-v.png", keyBackground(crop(c1, 26, 192, 24, 80), darkBg));
save("frame-gem-h.png", keyBackground(crop(c1, 400, 2, 48, 66), darkBg));
save("frame-gem-v.png", keyBackground(crop(c1, 2, 386, 66, 48), darkBg));

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

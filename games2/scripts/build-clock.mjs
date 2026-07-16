// One-shot: cut the four time-of-day celestial-clock dials + the pointer hand
// out of the maintainer's sheet-3 mocks into the pre-keyed PNGs the HUD
// overlays top-centre (client/public/ui/clock_*.png).
//
// Sources live OUTSIDE the repo (same policy as the HUD frame mocks):
//   $CLOCK_SRC_DIR/clock3-sheet.png  (2x2 quadrants: day/evening/night/morning
//                                     mock game screenshots, half-moon dial
//                                     hanging under the frame's top rail)
//   $CLOCK_SRC_DIR/clock3-hand.png   (ornate gold hand, pointing RIGHT, sun
//                                     disc hub at the left — used AS IS, no
//                                     flip, no recolour: the art carries its
//                                     own dark outline)
//
// Extraction rules (maintainer):
//  - The dial is ONLY the solid half-disc. The mocks float decorative dot
//    arcs + Roman numerals OUTSIDE the rim — "important to not include the
//    dots outside the clock" — so we keep exactly the largest CONNECTED
//    component below the frame rail; everything detached drops out.
//  - The mock gem's lower tip overlaps the disc top-centre; it ships with
//    the disc and the game's REAL frame gem covers it at mount (clock.ts).
//  - The crest/starburst above the rail is mock gem dressing — excluded.
//
// AAA rule from the sheet-2 round still applies: assets bake at EXACTLY the
// display resolution (box ÷DIV, hard pixel-stair alpha for dials, soft alpha
// for the rotating hand), rendered 1 asset px = 1 CSS px + pixelated. The
// mocks have no clean pixel grid — do not grid-guess.
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const SRC =
  process.env.CLOCK_SRC_DIR ||
  "/tmp/claude-0/-home-user/9b663e9c-b357-5388-9df4-7e56e3039f71/scratchpad";
const OUT = path.resolve("client/public/ui");
const T = 28; // lit = brighter than the black mock page
// Dial mock px per displayed px. The sheet-3 mocks are 1:1 game screenshots
// (maintainer: "the scale is wrong and should be x2" — the ÷2 bake halved
// the intended size), so the dials display at FULL mock resolution.
const DIV = 1;
const HAND_LEN_FRAC = 0.88; // hand length as a share of the dial radius

const sheet = PNG.sync.read(fs.readFileSync(path.join(SRC, "clock3-sheet.png")));
const lum = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return Math.max(img.data[i], img.data[i + 1], img.data[i + 2]);
};

// Quadrant boxes of the 2x2 sheet (gutters measured; layout is stable).
const QUADS = [
  { phase: "day", x0: 2, x1: 686, y0: 2, y1: 369 },
  { phase: "evening", x0: 737, x1: 1418, y0: 2, y1: 369 },
  { phase: "night", x0: 2, x1: 686, y0: 396, y1: 750 },
  { phase: "morning", x0: 737, x1: 1418, y0: 396, y1: 750 },
];

const cuts = [];
for (const q of QUADS) {
  // The frame's top rail = rows lit across most of the quadrant width.
  const rails = [];
  for (let y = q.y0; y < q.y0 + 230; y++) {
    let lit = 0;
    for (let x = q.x0; x < q.x1; x++) if (lum(sheet, x, y) > T) lit++;
    if (lit / (q.x1 - q.x0) > 0.55) rails.push(y);
  }
  const railBot = rails[rails.length - 1];
  const cut = railBot + 2; // disc starts just below the rail
  const cx = Math.round((q.x0 + q.x1) / 2);

  // Largest connected lit component below the cut = the half-disc (the
  // floating dots/numerals/annotation text are all detached and vanish).
  const bx0 = cx - 220, bx1 = cx + 220, by0 = cut, by1 = q.y1;
  const bw = bx1 - bx0, bh = by1 - by0;
  const comp = new Int32Array(bw * bh).fill(-1);
  const sizes = [];
  for (let s = 0; s < bw * bh; s++) {
    if (comp[s] >= 0 || lum(sheet, bx0 + (s % bw), by0 + ((s / bw) | 0)) <= T) continue;
    const id = sizes.length;
    let n = 0;
    const st = [s];
    while (st.length) {
      const p = st.pop();
      if (p < 0 || p >= bw * bh || comp[p] >= 0) continue;
      const x = p % bw, y = (p / bw) | 0;
      if (lum(sheet, bx0 + x, by0 + y) <= T) continue;
      comp[p] = id;
      n++;
      if (x > 0) st.push(p - 1);
      if (x < bw - 1) st.push(p + 1);
      st.push(p - bw, p + bw);
    }
    sizes.push(n);
  }
  const keep = sizes.indexOf(Math.max(...sizes));

  // Copy the component out with soft alpha where art met the black page
  // (the mock edges are slightly soft; a hard key rings).
  let minX = bw, maxX = -1, minY = bh, maxY = -1;
  for (let p = 0; p < bw * bh; p++) {
    if (comp[p] !== keep) continue;
    const x = p % bw, y = (p / bw) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = new PNG({ width: cw, height: ch });
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const p = (y + minY) * bw + (x + minX);
      if (comp[p] !== keep) continue;
      const si = ((by0 + y + minY) * sheet.width + bx0 + x + minX) * 4;
      const di = (y * cw + x) * 4;
      out.data[di] = sheet.data[si];
      out.data[di + 1] = sheet.data[si + 1];
      out.data[di + 2] = sheet.data[si + 2];
      const edge =
        (x === 0 || comp[p - 1] !== keep) ||
        (x === cw - 1 || comp[p + 1] !== keep) ||
        (y === 0 || comp[p - bw] !== keep) ||
        (y === ch - 1 || comp[p + bw] !== keep);
      out.data[di + 3] = edge
        ? Math.min(255, Math.round((Math.max(out.data[di], out.data[di + 1], out.data[di + 2]) / 160) * 255))
        : 255;
    }
  // Notch out the MOCK GEM's tip at top-centre (maintainer's red marking:
  // the extraction is the sky half-disc only — the gem belongs to the
  // frame, and the game's REAL gem occupies that spot). The gem sits at
  // the disc axis in every quadrant; contour measured on the day quadrant
  // (rows relative to the disc top, half-widths in mock px; rows 0-1 keep
  // the disc's own full-width shadow line except the gem beads).
  const NOTCH = [7, 7, 12, 11, 12, 10, 9, 8, 6, 6, 5, 3, 2];
  const axis = cw / 2;
  for (let y = 0; y < Math.min(NOTCH.length, ch); y++)
    for (let x = 0; x < cw; x++)
      if (Math.abs(x + 0.5 - axis) <= NOTCH[y]) out.data[(y * cw + x) * 4 + 3] = 0;

  // Register by the DISC's own axis (bbox midline): the mocks paint each
  // dial a few px off the quadrant centre, so quadrant-centre registration
  // drifted the stack ~10px between phases.
  cuts.push({
    phase: q.phase,
    img: out,
    cxOff: cw / 2, // disc axis inside the crop
    topOff: minY, // rows between the cut (rail bottom) and the disc top
    // For the dots pass: where this disc sits on the sheet.
    sheet: { axisX: bx0 + minX + cw / 2, cut, bx0, bx1 },
  });
  console.log(`${q.phase}: disc ${cw}x${ch}, top offset ${minY}`);
}

// One shared canvas, registered by (disc centre-x, rail row) so the stacked
// <img>s cross-fade without drifting. Sizes differ a few px between mocks —
// centre-x alignment carries the registration.
const halfW = Math.max(...cuts.map((c) => Math.max(c.cxOff, c.img.width - c.cxOff)));
const canW = Math.ceil((halfW * 2 + 1) / DIV) * DIV;
const canH = Math.ceil(Math.max(...cuts.map((c) => c.topOff + c.img.height)) / DIV) * DIV;
for (const c of cuts) {
  const pad = new PNG({ width: canW, height: canH });
  PNG.bitblt(c.img, pad, 0, 0, c.img.width, c.img.height, Math.round(canW / 2 - c.cxOff), c.topOff);
  const small = boxDown(pad, DIV);
  fs.writeFileSync(path.join(OUT, `clock_${c.phase}.png`), PNG.sync.write(small));
  console.log(`clock_${c.phase}.png  ${small.width}x${small.height}`);
}
console.log(`dial canvas ${canW / DIV}x${canH / DIV}, knobX ${canW / DIV / 2}`);

// ---- dots ----
// The floating gold dot arc around the SUN dial ships as its OWN static
// layer (maintainer: the dots must never fade with the time-of-day cross-
// fades — always the same). Extracted once from the day quadrant: small
// warm-gold detached components in the band around the disc; the grey
// "12H" label and 1px cut-row slivers fail the size/colour filter.
{
  const day = cuts.find((c) => c.phase === "day");
  const { axisX, cut, bx0, bx1 } = day.sheet;
  const by0 = cut, by1 = cut + 220;
  const bw = bx1 - bx0, bh = by1 - by0;
  const comp = new Int32Array(bw * bh).fill(-1);
  const dots = [];
  for (let s = 0; s < bw * bh; s++) {
    if (comp[s] >= 0 || lum(sheet, bx0 + (s % bw), by0 + ((s / bw) | 0)) <= T) continue;
    let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, rs = 0, gs = 0, bs = 0;
    const st = [s];
    while (st.length) {
      const p = st.pop();
      if (p < 0 || p >= bw * bh || comp[p] >= 0) continue;
      const x = p % bw, y = (p / bw) | 0;
      if (lum(sheet, bx0 + x, by0 + y) <= T) continue;
      comp[p] = 1;
      n++;
      const i = ((by0 + y) * sheet.width + bx0 + x) * 4;
      rs += sheet.data[i]; gs += sheet.data[i + 1]; bs += sheet.data[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) st.push(p - 1);
      if (x < bw - 1) st.push(p + 1);
      st.push(p - bw, p + bw);
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const warm = rs / n > bs / n + 8;
    if (n >= 12 && n <= 60 && w <= 10 && h <= 10 && warm)
      dots.push({ x0: bx0 + minX, x1: bx0 + maxX, y0: by0 + minY, y1: by0 + maxY });
  }
  const half = Math.ceil(Math.max(...dots.map((d) => Math.max(axisX - d.x0, d.x1 + 1 - axisX))) / DIV) * DIV + 2;
  const dotW = half * 2, dotH = Math.ceil(Math.max(...dots.map((d) => d.y1 + 1 - cut)) / DIV) * DIV + 2;
  const pad = new PNG({ width: dotW, height: dotH });
  for (const d of dots)
    for (let y = d.y0; y <= d.y1; y++)
      for (let x = d.x0; x <= d.x1; x++) {
        if (lum(sheet, x, y) <= T) continue;
        const si = (y * sheet.width + x) * 4;
        const di = ((y - cut) * dotW + Math.round(x - axisX + half)) * 4;
        pad.data[di] = sheet.data[si];
        pad.data[di + 1] = sheet.data[si + 1];
        pad.data[di + 2] = sheet.data[si + 2];
        pad.data[di + 3] = 255;
      }
  const small = boxDown(pad, DIV, 64); // gentle threshold: dots are 3x3 at display
  fs.writeFileSync(path.join(OUT, "clock_dots.png"), PNG.sync.write(small));
  console.log(`clock_dots.png  ${small.width}x${small.height}  (${dots.length} dots, axis-centred, top = rail bottom)`);
}

// ---- hand ----
// Points RIGHT in the mock; hub = the sun-face disc at the left end. Kept in
// its original gold (its own dark outline reads on every dial sky).
{
  const img = PNG.sync.read(fs.readFileSync(path.join(SRC, "clock3-hand.png")));
  const { width: w, height: h } = img;
  // Outside-flood key from the borders (backdrop is near-black).
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, x + (h - 1) * w);
  for (let y = 0; y < h; y++) stack.push(y * w, w - 1 + y * w);
  while (stack.length) {
    const p = stack.pop();
    if (bg[p] || lum(img, p % w, (p / w) | 0) > T) continue;
    bg[p] = 1;
    const x = p % w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (p >= w) stack.push(p - w);
    if (p < w * (h - 1)) stack.push(p + w);
  }
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let p = 0; p < w * h; p++) {
    if (bg[p]) {
      img.data[p * 4 + 3] = 0;
      continue;
    }
    const x = p % w, y = (p / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const full = new PNG({ width: cw, height: ch });
  PNG.bitblt(img, full, minX, minY, cw, ch, 0, 0);

  // Hub = centroid of the sun disc: the tallest columns of the LEFT third.
  const colExt = [];
  for (let x = 0; x < cw; x++) {
    let lo = -1, hi = -1;
    for (let y = 0; y < ch; y++)
      if (full.data[(y * cw + x) * 4 + 3] > 128) {
        if (lo < 0) lo = y;
        hi = y;
      }
    colExt.push(lo < 0 ? 0 : hi - lo + 1);
  }
  const leftMax = Math.max(...colExt.slice(0, Math.floor(cw * 0.4)));
  let sx = 0, sy = 0, n = 0;
  for (let x = 0; x < Math.floor(cw * 0.4); x++) {
    if (colExt[x] < leftMax * 0.8) continue;
    for (let y = 0; y < ch; y++)
      if (full.data[(y * cw + x) * 4 + 3] > 128) {
        sx += x;
        sy += y;
        n++;
      }
  }
  const hub = { x: sx / n, y: sy / n };
  let tip = { x: 0, y: 0, d: -1 };
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      if (full.data[(y * cw + x) * 4 + 3] <= 128) continue;
      const d = (x - hub.x) ** 2 + (y - hub.y) ** 2;
      if (d > tip.d) tip = { x, y, d };
    }
  const len = Math.sqrt(tip.d);
  const dialRadius = canW / DIV / 2;
  const div = Math.max(1, Math.round(len / (dialRadius * HAND_LEN_FRAC)));
  const fine = boxDown(full, div, 0); // soft alpha: the hand rotates at runtime
  const deg = (Math.atan2(tip.x - hub.x, tip.y - hub.y) * -180) / Math.PI;
  fs.writeFileSync(path.join(OUT, "clock_hand.png"), PNG.sync.write(fine));
  console.log(
    `clock_hand.png  ${fine.width}x${fine.height}  div ${div}  ` +
      `hub (${(hub.x / div).toFixed(1)}, ${(hub.y / div).toFixed(1)})  ` +
      `angle-from-down ${deg.toFixed(1)}deg  len ${(len / div).toFixed(0)}px`
  );
}

function boxDown(img, f, thresh = 128) {
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++)
        for (let dx = 0; dx < f; dx++) {
          const i = ((y * f + dy) * img.width + x * f + dx) * 4;
          const al = img.data[i + 3];
          r += img.data[i] * al;
          g += img.data[i + 1] * al;
          b += img.data[i + 2] * al;
          a += al;
        }
      const o = (y * w + x) * 4;
      out.data[o] = a ? Math.round(r / a) : 0;
      out.data[o + 1] = a ? Math.round(g / a) : 0;
      out.data[o + 2] = a ? Math.round(b / a) : 0;
      // Hard pixel edge for dials; thresh 0 keeps the averaged SOFT alpha
      // (the rotating hand shreds into a ragged line when thresholded).
      out.data[o + 3] = thresh === 0 ? Math.round(a / (f * f)) : a / (f * f) >= thresh ? 255 : 0;
    }
  return out;
}

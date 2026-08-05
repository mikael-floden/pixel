// Extract the character-select ring v2 pieces from the maintainer's authored
// frame art (2026-07-17): 4 decorated corners + one repeatable plain-beam
// strip per side. The source is NATIVE-resolution pixel art (1408×768,
// 1px grid measured) on pure black; it lives OUTSIDE the repo (same policy
// as the HUD frame mocks) — pass SRC=... to override the default path.
//
// Outputs (committed): client/public/ui2/select2/corner-{tl,tr,bl,br}.png
//                      client/public/ui2/select2/beam-{top,bottom,left,right}.png
//                      + select2.json (the cut geometry the client compose reads)
//
// Rules: background keyed by FLOOD from the outer border AND the enclosed
// interior (never by colour alone — the art's dark outlines are near-black);
// piece-to-piece joints stay HARD (they butt at runtime); only the keyed
// silhouette exists as alpha. No scaling anywhere — pieces ship 1:1.
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "client", "public", "ui2", "select2");
const SRC = process.env.SRC ||
  "/root/.claude/uploads/acbf8e56-1a5a-520e-a01f-328c70374792/c3f5f5e6-1784290159382.png";

const src = PNG.sync.read(fs.readFileSync(SRC));
const { width: W, height: H, data: D } = src;
const idx = (x, y) => (y * W + x) * 4;
const dark = (x, y) => {
  const i = idx(x, y);
  return Math.max(D[i], D[i + 1], D[i + 2]) < 26;
};

// ---- key: flood the black background from outside + the enclosed middle ----
const bg = new Uint8Array(W * H);
const flood = (sx, sy) => {
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= W || y < 0 || y >= H || bg[y * W + x] || !dark(x, y)) continue;
    bg[y * W + x] = 1;
    stack.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
  }
};
for (let x = 0; x < W; x++) { flood(x, 0); flood(x, H - 1); }
for (let y = 0; y < H; y++) { flood(0, y); flood(W - 1, y); }
flood(W >> 1, H >> 1); // enclosed interior
const solid = (x, y) => !bg[y * W + x];

// ---- measure the plain beam bands at the midpoints ----
const rowSpan = (x) => {
  const bands = [];
  let a = -1;
  for (let y = 0; y < H; y++) {
    if (solid(x, y)) { if (a < 0) a = y; }
    else if (a >= 0) { bands.push([a, y]); a = -1; }
  }
  return bands;
};
const colSpan = (y) => {
  const bands = [];
  let a = -1;
  for (let x = 0; x < W; x++) {
    if (solid(x, y)) { if (a < 0) a = x; }
    else if (a >= 0) { bands.push([a, x]); a = -1; }
  }
  return bands;
};
const midX = W >> 1, midY = H >> 1;
const hBands = rowSpan(midX); // [topBeam, bottomBeam]
const vBands = colSpan(midY); // [leftBeam, rightBeam]
if (hBands.length !== 2 || vBands.length !== 2)
  throw new Error(`unexpected bands: h=${JSON.stringify(hBands)} v=${JSON.stringify(vBands)}`);
const [TOP, BOT] = hBands;
const [LEFT, RIGHT] = vBands;
console.log("beam bands: top", TOP, "bottom", BOT, "left", LEFT, "right", RIGHT);

// ---- corner extents: how far decor reaches along each edge ----
// A column belongs to a top corner while it has solid pixels OUTSIDE the
// top-beam band (in the upper half); pad a little for outline breathing room.
const PAD = 4;
const decorTopCol = (x) => {
  for (let y = 0; y < midY; y++)
    if (solid(x, y) && (y < TOP[0] - 1 || y > TOP[1])) return true;
  return false;
};
const decorBotCol = (x) => {
  for (let y = midY; y < H; y++)
    if (solid(x, y) && (y < BOT[0] - 1 || y > BOT[1])) return true;
  return false;
};
const decorLeftRow = (y) => {
  for (let x = 0; x < midX; x++)
    if (solid(x, y) && (x < LEFT[0] - 1 || x > LEFT[1])) return true;
  return false;
};
const decorRightRow = (y) => {
  for (let x = midX; x < W; x++)
    if (solid(x, y) && (x < RIGHT[0] - 1 || x > RIGHT[1])) return true;
  return false;
};
const scanLast = (from, to, step, test) => {
  let last = from;
  for (let v = from; step > 0 ? v < to : v > to; v += step) if (test(v)) last = v;
  return last;
};
const tlX = scanLast(0, midX, 1, decorTopCol) + PAD;
const trX = scanLast(W - 1, midX, -1, decorTopCol) - PAD;
const blX = scanLast(0, midX, 1, decorBotCol) + PAD;
const brX = scanLast(W - 1, midX, -1, decorBotCol) - PAD;
const tlY = scanLast(0, midY, 1, decorLeftRow) + PAD;
const blY = scanLast(H - 1, midY, -1, decorLeftRow) - PAD;
const trY = scanLast(0, midY, 1, decorRightRow) + PAD;
const brY = scanLast(H - 1, midY, -1, decorRightRow) - PAD;
console.log("corner cuts: tl", tlX, tlY, "tr", trX, trY, "bl", blX, blY, "br", brX, brY);

// ---- write a piece (keyed) ----
fs.mkdirSync(OUT, { recursive: true });
const write = (x0, y0, x1, y1, name) => {
  const w = x1 - x0, h = y1 - y0;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = idx(x0 + x, y0 + y), d = (y * w + x) * 4;
    if (bg[(y0 + y) * W + x0 + x]) continue; // transparent
    out.data[d] = D[s]; out.data[d + 1] = D[s + 1];
    out.data[d + 2] = D[s + 2]; out.data[d + 3] = 255;
  }
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(out));
  console.log(name, `${w}x${h} from (${x0},${y0})`);
  return { w, h };
};

// corners include their beam stubs out to the cut lines
const tl = write(0, 0, tlX, tlY, "corner-tl.png");
const tr = write(trX, 0, W, trY, "corner-tr.png");
const bl = write(0, blY, blX, H, "corner-bl.png");
const br = write(brX, brY, W, H, "corner-br.png");

// ---- repeatable beam strips: a clean span from the middle of each run ----
// (decor-free by construction: strictly between the corner cuts, and the
// corner scan already proved these columns/rows carry beam-band pixels only)
const STRIP = 128;
const hx0 = Math.max(tlX, blX), hx1 = Math.min(trX, brX);
const hxm = ((hx0 + hx1) >> 1) - (STRIP >> 1);
const beamTop = write(hxm, TOP[0] - 1, hxm + STRIP, TOP[1] + 1, "beam-top.png");
const beamBot = write(hxm, BOT[0] - 1, hxm + STRIP, BOT[1] + 1, "beam-bottom.png");
const vy0 = Math.max(tlY, trY), vy1 = Math.min(blY, brY);
const vym = ((vy0 + vy1) >> 1) - (STRIP >> 1);
const beamLeft = write(LEFT[0] - 1, vym, LEFT[1] + 1, vym + STRIP, "beam-left.png");
const beamRight = write(RIGHT[0] - 1, vym, RIGHT[1] + 1, vym + STRIP, "beam-right.png");

// ---- outer empty margins: how far each corner's outward edges are from
// any opaque pixel (the client shifts the whole ring outward by the min of
// each side's two corners, so the beams hug the screen edge without
// clipping one art pixel — maintainer: "the border is extremely far away
// from the edge") ----
const firstOpaque = (x0, y0, x1, y1, edge) => {
  const opaque = (x, y) => solid(x, y);
  const limit = edge === "top" || edge === "bottom" ? y1 - y0 : x1 - x0;
  for (let d = 0; d < limit; d++) {
    if (edge === "top" || edge === "bottom") {
      const y = edge === "top" ? y0 + d : y1 - 1 - d;
      for (let x = x0; x < x1; x++) if (opaque(x, y)) return d;
    } else {
      const x = edge === "left" ? x0 + d : x1 - 1 - d;
      for (let y = y0; y < y1; y++) if (opaque(x, y)) return d;
    }
  }
  return limit;
};
const margins = {
  tl: { top: firstOpaque(0, 0, tlX, tlY, "top"), left: firstOpaque(0, 0, tlX, tlY, "left") },
  tr: { top: firstOpaque(trX, 0, W, trY, "top"), right: firstOpaque(trX, 0, W, trY, "right") },
  bl: { bottom: firstOpaque(0, blY, blX, H, "bottom"), left: firstOpaque(0, blY, blX, H, "left") },
  br: { bottom: firstOpaque(brX, brY, W, H, "bottom"), right: firstOpaque(brX, brY, W, H, "right") },
};
console.log("outer margins:", JSON.stringify(margins));

// ---- geometry manifest the client compose reads ----
const geo = {
  margins,
  art: { w: W, h: H },
  beams: {
    top: { y: TOP[0] - 1, h: beamTop.h },
    bottom: { y: BOT[0] - 1, h: beamBot.h },
    left: { x: LEFT[0] - 1, w: beamLeft.w },
    right: { x: RIGHT[0] - 1, w: beamRight.w },
  },
  corners: {
    tl: { w: tl.w, h: tl.h },
    tr: { w: tr.w, h: tr.h },
    bl: { w: bl.w, h: bl.h },
    br: { w: br.w, h: br.h },
  },
  // inner edges (content padding): the beams' inside faces
  inner: { top: TOP[1] + 1, bottom: BOT[0] - 1, left: LEFT[1] + 1, right: RIGHT[0] - 1 },
};
fs.writeFileSync(path.join(OUT, "select2.json"), JSON.stringify(geo, null, 2));
console.log("select2.json", JSON.stringify(geo));

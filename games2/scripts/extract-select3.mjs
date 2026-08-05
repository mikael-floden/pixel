// Extract the character-select WIDGET set from the maintainer's concept
// mock (2026-07-17, "new concept art for the character select screen"):
// per-world themed cards, the crystal character pedestal, the stone name
// tablet, the gold ENTER WORLD plaque (text baked by design), the parchment
// install scroll. The mock is an AI regen of a live phone screenshot —
// intent + extraction source, not pixel ground truth: every element is
// flood-keyed from its own rect and area-average baked ÷1.75 (mock 688px
// wide over the 393px virtual layout) to its FINAL display resolution,
// then rendered 1:1 + pixelated (no runtime scaling).
//
// Source lives outside the repo (upload); pass SRC=... to override.
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "client", "public", "ui2", "select3");
const SRC = process.env.SRC ||
  "/root/.claude/uploads/acbf8e56-1a5a-520e-a01f-328c70374792/dc94c3e8-1784296738573.png";
const F = 688 / 393; // mock px per virtual px

const src = PNG.sync.read(fs.readFileSync(SRC));
const { width: W, data: D } = src;
const idx = (x, y) => (y * W + x) * 4;
// the mock backdrop is dark blue-slate stone (~24,26,37 ± cracks/sparkle
// haze); elements are brighter or warmer. Backdrop-ish = dark AND not
// warmer-than-blue.
const isBg = (x, y) => {
  const i = idx(x, y);
  const [r, g, b] = [D[i], D[i + 1], D[i + 2]];
  return Math.max(r, g, b) < 95 && b >= r - 4;
};

// Row-median inpaint: inside the box, replace pixels that deviate from
// their row's dominant colour (the flat stone/crystal faces) — used to
// clear the mock's baked feet + name labels off the pedestal and tablet.
const inpaint = (x0, y0, x1, y1, box, thresh = 45, skipBg = true) => {
  // skipBg: medians/fills over ART pixels only — filling backdrop pixels
  // would stop them keying out later (a browned stripe shipped once). OFF
  // for pieces whose own faces are dark enough to pass isBg (the pedestal's
  // indigo front) — there the crop must simply avoid backdrop rows.
  for (let y = y0 + box.y0; y < y0 + box.y1; y++) {
    const rs = [], gs = [], bs = [];
    for (let x = x0 + box.x0; x < x0 + box.x1; x++) {
      if (skipBg && isBg(x, y)) continue;
      const i = idx(x, y);
      rs.push(D[i]); gs.push(D[i + 1]); bs.push(D[i + 2]);
    }
    if (rs.length < 8) continue; // mostly backdrop — nothing to repair here
    const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1];
    const [mr, mg, mb] = [med(rs), med(gs), med(bs)];
    for (let x = x0 + box.x0; x < x0 + box.x1; x++) {
      if (skipBg && isBg(x, y)) continue;
      const i = idx(x, y);
      const dist = Math.abs(D[i] - mr) + Math.abs(D[i + 1] - mg) + Math.abs(D[i + 2] - mb);
      if (dist > thresh) {
        // jitter from the row medians so the fill isn't a dead-flat stripe
        const j = ((x * 13 + y * 7) % 5) - 2;
        D[i] = mr + j; D[i + 1] = mg + j; D[i + 2] = mb + j;
      }
    }
  }
};

const cut = (x0, y0, x1, y1, name) => {
  const w = x1 - x0, h = y1 - y0;
  // flood the backdrop from the rect border
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
  for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= w || y < 0 || y >= h || bg[y * w + x]) continue;
    if (!isBg(x0 + x, y0 + y)) continue;
    bg[y * w + x] = 1;
    stack.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
  }
  // full-res RGBA with keyed alpha + 1px feather at the key boundary
  const rgba = new Float64Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (bg[y * w + x]) continue;
    const s = idx(x0 + x, y0 + y);
    let a = 255;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h || bg[ny * w + nx]) { a = 128; break; }
    }
    rgba[o] = D[s]; rgba[o + 1] = D[s + 1]; rgba[o + 2] = D[s + 2]; rgba[o + 3] = a;
  }
  // area-average bake to final display resolution (÷F)
  const ow = Math.round(w / F), oh = Math.round(h / F);
  const out = new PNG({ width: ow, height: oh });
  for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    const sx0 = Math.floor(ox * F), sx1 = Math.max(sx0 + 1, Math.floor((ox + 1) * F));
    const sy0 = Math.floor(oy * F), sy1 = Math.max(sy0 + 1, Math.floor((oy + 1) * F));
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const o = (sy * w + sx) * 4;
      const al = rgba[o + 3];
      r += rgba[o] * al; g += rgba[o + 1] * al; b += rgba[o + 2] * al; a += al; n++;
    }
    const d = (oy * ow + ox) * 4;
    if (a > 0) {
      out.data[d] = Math.round(r / a);
      out.data[d + 1] = Math.round(g / a);
      out.data[d + 2] = Math.round(b / a);
      out.data[d + 3] = Math.round(a / n);
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), PNG.sync.write(out));
  console.log(name, `${ow}x${oh} (from ${w}x${h} @ ${x0},${y0})`);
  return { w: ow, h: oh };
};

// ---- baked-leftover cleanup (mock px, relative to each piece's rect) ----
// NOTE: the character PEDESTAL was cut from this set — the mock bakes the
// Man's feet + label into it and its indigo faces are the same colour
// family as the backdrop, so neither inpaint nor keying produces a clean
// piece. Needs a standalone pedestal sprite from the maintainer.
// name tablet (44,1114)-(300,1200): baked "Juno".
inpaint(44, 1114, 300, 1200, { x0: 30, x1: 226, y0: 18, y1: 68 }, 34);

// ---- element rects (mock px, read off the concept) ----
const pieces = {
  "world-demo_isle": cut(34, 740, 228, 836, "world-demo_isle.png"),
  "world-demo_lost": cut(238, 736, 440, 838, "world-demo_lost.png"),
  "world-glow_test": cut(460, 734, 654, 840, "world-glow_test.png"),
  "name-tablet": cut(44, 1114, 300, 1200, "name-tablet.png"),
  "enter-plaque": cut(408, 1108, 654, 1204, "enter-plaque.png"),
  "install-scroll": cut(138, 1224, 550, 1294, "install-scroll.png"),
};
fs.writeFileSync(path.join(OUT, "select3.json"), JSON.stringify(pieces, null, 2));
console.log(JSON.stringify(pieces));

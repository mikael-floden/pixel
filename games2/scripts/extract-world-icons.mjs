// Extract the per-world ICONS from the maintainer's "World Selection Atlas"
// sheet (2026-07-17): seven square wooden-framed tiles, one per maps2 world.
// The tiles are opaque squares — a straight crop of each frame rect, then an
// area-average bake to the 64×64 display size (rendered 1:1 + pixelated).
// The sheet's duplicate Occlusion/Trans variants are skipped (the cleaner of
// each pair is used). Source lives outside the repo; SRC=... to override.
import { PNG } from "pngjs";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "client", "public", "ui2", "select3");
const SRC = process.env.SRC ||
  "/root/.claude/uploads/acbf8e56-1a5a-520e-a01f-328c70374792/903eda7c-1784304622847.png";
const SIZE = 64;

const src = PNG.sync.read(fs.readFileSync(SRC));
const { width: W, data: D } = src;

// atlas grid (sheet px, verified by crop montage): 193px frames, two rows
const RECTS = [
  ["ring_test", 152, 142, 345, 336],
  ["demo_isle", 380, 142, 573, 336],
  ["demo_lost", 608, 142, 801, 336],
  ["glow_test", 836, 142, 1029, 336],
  ["occlusion_test", 1064, 142, 1257, 336], // top-right variant (cleaner)
  ["prop_demo", 380, 428, 573, 622],
  ["trans_demo", 608, 428, 801, 622], // solid lantern (ghost variant skipped)
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, x0, y0, x1, y1] of RECTS) {
  const w = x1 - x0, h = y1 - y0;
  const out = new PNG({ width: SIZE, height: SIZE });
  for (let oy = 0; oy < SIZE; oy++) for (let ox = 0; ox < SIZE; ox++) {
    let r = 0, g = 0, b = 0, n = 0;
    const sx0 = x0 + Math.floor((ox * w) / SIZE), sx1 = x0 + Math.max(1 + Math.floor((ox * w) / SIZE), Math.floor(((ox + 1) * w) / SIZE));
    const sy0 = y0 + Math.floor((oy * h) / SIZE), sy1 = y0 + Math.max(1 + Math.floor((oy * h) / SIZE), Math.floor(((oy + 1) * h) / SIZE));
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const i = (sy * W + sx) * 4;
      r += D[i]; g += D[i + 1]; b += D[i + 2]; n++;
    }
    const d = (oy * SIZE + ox) * 4;
    out.data[d] = Math.round(r / n);
    out.data[d + 1] = Math.round(g / n);
    out.data[d + 2] = Math.round(b / n);
    out.data[d + 3] = 255;
  }
  fs.writeFileSync(path.join(OUT, `icon-${name}.png`), PNG.sync.write(out));
  console.log(`icon-${name}.png ${SIZE}x${SIZE}`);
}

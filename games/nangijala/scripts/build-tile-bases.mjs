// Generate client/public/tile-bases.json — each tile variant's TRUE drawn
// base (its lowest opaque row), measured from the art at BUILD time.
//
// Tall (128px) tile sets are not uniform: "extra long" variants fill the
// canvas to row 128 (waterfalls, cliff_lava, spires) while "long" ones stop
// short (cliff_gold ends at 120). The renderer's old constant lift
// (imgH - 64) was only right for the short kind — full-canvas art sank into
// the ground (playtester: cliff_lava 06 buried by the spawn fire, sunken
// stations all over /#emission).
//
// The client lifts art by max(0, base - groundBase): its base then sits
// exactly where a flat ground tile's own bottom skirt sits, per variant, no
// runtime pixel scanning. groundBase is measured from grass tile_00.
// Runs as part of `npm run manifest` so it regenerates with the art.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Art domains live at the repo root by default; ASSETS_ROOT overrides it (Docker).
const ASSETS_ROOT = process.env.ASSETS_ROOT || join(SCRIPT_DIR, "..", "..", "..");
const TILES = join(ASSETS_ROOT, "tiles");
const OUT = join(SCRIPT_DIR, "../client/public/tile-bases.json");

/** Minimal PNG decode (8-bit RGBA/RGB, non-interlaced — what PixelLab emits).
 * No image library so this also runs inside the production Docker build
 * (same approach as build-manifest.mjs). */
function pngAlpha(p) {
  const b = readFileSync(p);
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const bitDepth = b[24];
  const colorType = b[25];
  const interlace = b[28];
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) return null;
  const channels = colorType === 6 ? 4 : 3;
  let off = 8;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const img = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = img.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? img.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const bb = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const pth = a + bb - c;
        const pa = Math.abs(pth - a);
        const pb = Math.abs(pth - bb);
        const pc = Math.abs(pth - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
      }
      out[i] = v & 0xff;
    }
  }
  const opaque = (x, y) => (colorType === 2 ? true : img[y * stride + x * channels + 3] > 16);
  return { w, h, opaque };
}

/** Lowest opaque row (exclusive) — where the drawn art actually ends. */
function baseOf(file) {
  const png = pngAlpha(file);
  if (!png) throw new Error(`unsupported PNG format: ${file}`);
  for (let y = png.h - 1; y >= 0; y--)
    for (let x = 0; x < png.w; x++)
      if (png.opaque(x, y)) return y + 1;
  return png.h;
}

const categories = {};
for (const cat of readdirSync(TILES).sort()) {
  const dir = join(TILES, cat);
  if (!existsSync(join(dir, "tile_00.png"))) continue;
  const files = readdirSync(dir)
    .filter((f) => /^tile_\d+\.png$/.test(f))
    .sort();
  categories[cat] = files.map((f) => baseOf(join(dir, f)));
}

const groundBase = categories.grass?.[0] ?? 55;
writeFileSync(OUT, JSON.stringify({ format: "tile-bases@1", groundBase, categories }) + "\n");
const tall = Object.entries(categories).filter(([, b]) => Math.max(...b) > 64);
console.log(
  `tile-bases: ${Object.keys(categories).length} categories (${tall.length} tall), ` +
    `groundBase ${groundBase}, cliff_lava ${JSON.stringify(categories.cliff_lava)}, ` +
    `cliff_gold ${JSON.stringify(categories.cliff_gold)}`,
);

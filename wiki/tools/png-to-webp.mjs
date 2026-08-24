// PNG -> LOSSLESS WEBP, the repo's way, without Pillow.
//
// games2/scripts/to-webp.py is the shared converter and it needs Pillow — which
// this container loses whenever it recycles, and reinstalling a native imaging
// stack to convert one 24x24 icon is a poor trade. This does the same job with
// a wasm encoder: lossless AND exact (both non-default), so nothing is
// resampled and the RGB under fully transparent pixels is left alone.
//
// AND IT REFUSES TO SHIP A FILE THAT DOES NOT ROUND-TRIP: the result is decoded
// with the wiki's own VP8L decoder and compared pixel by pixel to the source,
// exactly as to-webp.py does. Used for wiki/site/icons/coin.webp (24x24, 440 B,
// 0 mismatches).
//
//   npm i --no-save @jsquash/webp   (in games2/)
//   node wiki/tools/png-to-webp.mjs <in.png> <out.webp>
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import encode, { init } from "/home/user/pixel/games2/node_modules/@jsquash/webp/encode.js";
// The wasm loader reaches for fetch() on a file: URL, which Node will not do —
// hand it the compiled module instead.
const M = "/home/user/pixel/games2/node_modules/@jsquash/webp/codec/enc/";
async function ready() {
  for (const f of ["webp_enc_simd.wasm", "webp_enc.wasm"]) {
    try { await init(await WebAssembly.compile(readFileSync(M + f))); return; } catch { /* try the plain build */ }
  }
  throw new Error("no usable webp encoder build");
}
import { decodeWebP } from "/home/user/pixel/wiki/lib/webp-pixels.mjs";

// --- minimal PNG reader (8-bit RGBA, non-interlaced — which this file is)
function readPNG(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    p += 12 + len;
  }
  if (bd !== 8 || ct !== 6) throw new Error(`unsupported PNG: bitdepth ${bd} colourtype ${ct}`);
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(w * h * 4);
  const bpp = 4, stride = w * bpp;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
    out.set(cur, y * stride); prev = cur;
  }
  return { width: w, height: h, data: out };
}

await ready();
const src = readPNG(readFileSync(process.argv[2]));
const webp = await encode(src, { lossless: 1, quality: 100, exact: 1 });
writeFileSync(process.argv[3], Buffer.from(webp));

// ROUND-TRIP OR IT DOES NOT SHIP — the same rule to-webp.py enforces.
const back = decodeWebP(readFileSync(process.argv[3]));
if (back.w !== src.width || back.h !== src.height) throw new Error("size changed");
let bad = 0;
for (let i = 0; i < back.pix.length; i++) {
  const a = back.pix[i], r = (a >> 16) & 255, g = (a >> 8) & 255, b2 = a & 255, al = a >>> 24;
  const j = i * 4;
  if (al !== src.data[j + 3]) { bad++; continue; }
  if (al > 0 && (r !== src.data[j] || g !== src.data[j + 1] || b2 !== src.data[j + 2])) bad++;
}
console.log(`${process.argv[3]}: ${back.w}x${back.h}, ${Buffer.from(webp).length} B, mismatched pixels: ${bad}`);
if (bad) process.exit(1);

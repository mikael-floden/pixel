// Zero-dependency WebP lossless (VP8L) decoder — enough of one to measure art.
//
// WHY THIS EXISTS (maintainer 2026-08-13: "It should just work when someone
// pushes"): the wiki's animation viewer needs each sprite's real content box
// (opaque pixels, padding cropped) and one shared stage size per domain. That
// measurement used to live in a Python/numpy tool, and the deploy image is
// node:22-slim — no Python — so the numbers could only be refreshed by a human
// re-running a script, and art pushed between refreshes shipped unmeasured
// (the Diretusk scrollbar, twice). With a decoder in plain JS, build.mjs —
// which ALREADY runs inside every deploy's image build — measures new art the
// moment any agent's push deploys. No timers, no second pipeline.
//
// Scope is deliberately narrow: VP8L only (a census on 2026-08-13 found all
// 24,103 files across monsters/, scenery/ and characters2/ are VP8L — the
// repo-wide lossless-WebP policy, CLAUDE.md). Lossy VP8 or anything else
// throws, the caller records the clip as unmeasured and warns, and the
// viewer's in-browser self-measure covers the display. Wrong numbers are the
// one thing this file must never produce, so every error path throws.
//
// Verified against Pillow (md5 of the full RGBA buffer, not just bounds) by
// wiki/tools/check-pixels.mjs. The same "own reader, proven against Pillow"
// pattern as the header reader in games2/scripts/imagelib.mjs.
import { readFileSync } from "node:fs";

// ------------------------------------------------------------ bit reading
// VP8L packs values LSB-first. Huffman code BITS arrive first-bit-is-MSB of
// the canonical code (DEFLATE-style), which just means "append each new bit
// at the bottom of the code" — bit() below is used for both.
class Br {
  constructor(bytes) { this.b = bytes; this.pos = 0; this.end = bytes.length * 8; }
  bit() {
    if (this.pos >= this.end) throw new Error("bitstream overrun");
    const v = (this.b[this.pos >> 3] >> (this.pos & 7)) & 1;
    this.pos++;
    return v;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.bit() << i;
    return v;
  }
}

// --------------------------------------------------------------- huffman
// Canonical Huffman from code lengths, decoded bit by bit with the classic
// per-length first-code/offset walk. Max length in VP8L is 15.
function makeHuff(lens) {
  const MAX = 15;
  const count = new Array(MAX + 1).fill(0);
  for (const l of lens) if (l) { if (l > MAX) throw new Error("code length > 15"); count[l]++; }
  const total = count.reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error("empty huffman code");
  if (total === 1) {                       // single symbol: zero bits per read
    const sym = lens.findIndex((l) => l > 0);
    return { single: sym };
  }
  // Kraft check so a corrupt table fails here, not as garbage pixels.
  let left = 1 << MAX;
  for (let l = 1; l <= MAX; l++) { left -= count[l] << (MAX - l); if (left < 0) throw new Error("over-subscribed code"); }
  const syms = [];
  for (let l = 1; l <= MAX; l++)
    for (let s = 0; s < lens.length; s++) if (lens[s] === l) syms.push(s);
  return { count, syms };
}
function huffDecode(h, br) {
  if (h.single !== undefined) return h.single;
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= 15; len++) {
    code = (code << 1) | br.bit();
    const n = h.count[len];
    if (code - first < n) return h.syms[index + code - first];
    index += n; first = (first + n) << 1;
  }
  throw new Error("bad huffman code");
}

// Code lengths for a Huffman code are themselves Huffman coded, in this order.
const CLC_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function readHuffCode(br, alphabetSize) {
  if (br.bit()) {                                        // "simple" code
    const numSymbols = br.bit() + 1;
    const first8 = br.bit();
    const lens = new Array(alphabetSize).fill(0);
    const s0 = br.bits(first8 ? 8 : 1);
    if (s0 >= alphabetSize) throw new Error("simple symbol out of range");
    lens[s0] = 1;
    if (numSymbols === 2) {
      const s1 = br.bits(8);
      if (s1 >= alphabetSize) throw new Error("simple symbol out of range");
      lens[s1] = 1;
    }
    return makeHuff(lens);
  }
  const numCodes = 4 + br.bits(4);
  const clcLens = new Array(19).fill(0);
  for (let i = 0; i < numCodes; i++) clcLens[CLC_ORDER[i]] = br.bits(3);
  const clc = makeHuff(clcLens);
  // Optional cap on how many code-length SYMBOLS are read (not output).
  let maxSymbol = alphabetSize;
  if (br.bit()) {
    const nbits = 2 + 2 * br.bits(3);
    maxSymbol = 2 + br.bits(nbits);
  }
  const lens = new Array(alphabetSize).fill(0);
  let sym = 0, prev = 8;
  while (sym < alphabetSize && maxSymbol > 0) {
    maxSymbol--;
    const c = huffDecode(clc, br);
    if (c < 16) {
      lens[sym++] = c;
      if (c !== 0) prev = c;
    } else if (c === 16) {
      const n = 3 + br.bits(2);
      for (let i = 0; i < n && sym < alphabetSize; i++) lens[sym++] = prev;
    } else if (c === 17) {
      const n = 3 + br.bits(3);
      sym += n;
    } else {                                             // 18
      const n = 11 + br.bits(7);
      sym += n;
    }
  }
  if (sym > alphabetSize) throw new Error("code lengths overflow alphabet");
  return makeHuff(lens);
}

// -------------------------------------------------- LZ77 distance mapping
// The first 120 distance codes are 2D offsets into the rows above (libwebp's
// kCodeToPlane): high nibble = dy, low nibble = 8-dx — note the SIGN, dx is
// eight MINUS the nibble; reading it as nibble-minus-eight mirrors every
// sideways reference and corrupts exactly the wide strips. Larger codes are
// plain linear distances. check-pixels.mjs proves this table against Pillow
// over the whole corpus, so a wrong byte here cannot survive quietly.
const CODE_TO_PLANE = [
  0x18, 0x07, 0x17, 0x19, 0x28, 0x06, 0x27, 0x29, 0x16, 0x1a,
  0x26, 0x2a, 0x38, 0x05, 0x37, 0x39, 0x15, 0x1b, 0x36, 0x3a,
  0x25, 0x2b, 0x48, 0x04, 0x47, 0x49, 0x14, 0x1c, 0x35, 0x3b,
  0x46, 0x4a, 0x24, 0x2c, 0x58, 0x45, 0x4b, 0x34, 0x3c, 0x03,
  0x57, 0x59, 0x13, 0x1d, 0x56, 0x5a, 0x23, 0x2d, 0x44, 0x4c,
  0x55, 0x5b, 0x33, 0x3d, 0x68, 0x02, 0x67, 0x69, 0x12, 0x1e,
  0x66, 0x6a, 0x22, 0x2e, 0x54, 0x5c, 0x43, 0x4d, 0x65, 0x6b,
  0x32, 0x3e, 0x78, 0x01, 0x77, 0x79, 0x53, 0x5d, 0x11, 0x1f,
  0x64, 0x6c, 0x42, 0x4e, 0x76, 0x7a, 0x21, 0x2f, 0x75, 0x7b,
  0x31, 0x3f, 0x63, 0x6d, 0x52, 0x5e, 0x00, 0x74, 0x7c, 0x41,
  0x4f, 0x10, 0x20, 0x62, 0x6e, 0x30, 0x73, 0x7d, 0x51, 0x5f,
  0x40, 0x72, 0x7e, 0x61, 0x6f, 0x50, 0x71, 0x7f, 0x60, 0x70,
];
function planeToDist(plane, w) {
  if (plane > 120) return plane - 120;
  const c = CODE_TO_PLANE[plane - 1];
  const dy = c >> 4, dx = 8 - (c & 0xf);
  const d = dy * w + dx;
  return d < 1 ? 1 : d;
}
// LZ77 length/distance prefix values.
function prefixVal(code, br) {
  if (code < 4) return code + 1;
  const extra = (code - 2) >> 1;
  const offset = (2 + (code & 1)) << extra;
  return offset + br.bits(extra) + 1;
}

const sub = (v, bits) => (v + (1 << bits) - 1) >> bits;

// -------------------------------------------------------- the image stream
// Decodes one VP8L "spatially coded image". Level 0 (the real image) may
// carry transforms and a meta-Huffman image; the little helper images inside
// transforms may not, but they DO get their own color cache.
function decodeImageStream(br, w, h, isLevel0) {
  const transforms = [];
  if (isLevel0) {
    const seen = new Set();
    while (br.bit()) {
      const type = br.bits(2);
      if (seen.has(type)) throw new Error("transform repeated");
      seen.add(type);
      if (type === 2) {                                  // subtract green
        transforms.push({ type });
      } else if (type === 3) {                           // color indexing
        const size = br.bits(8) + 1;
        const palPix = decodeImageStream(br, size, 1, false);
        // Palette entries are stored as deltas from the previous entry.
        for (let i = 1; i < size; i++) {
          const a = palPix[i], b = palPix[i - 1];
          palPix[i] = (((a & 0xff00ff00) + (b & 0xff00ff00)) & 0xff00ff00
            | ((a & 0x00ff00ff) + (b & 0x00ff00ff)) & 0x00ff00ff) >>> 0;
        }
        const widthBits = size <= 2 ? 3 : size <= 4 ? 2 : size <= 16 ? 1 : 0;
        transforms.push({ type, pal: palPix, size, widthBits, unpackedW: w });
        if (widthBits > 0) w = sub(w, widthBits);        // pixels get bundled
      } else {                                           // 0 predictor / 1 color
        const sizeBits = br.bits(3) + 2;
        const tw = sub(w, sizeBits), th = sub(h, sizeBits);
        const tiles = decodeImageStream(br, tw, th, false);
        transforms.push({ type, sizeBits, tw, tiles });
      }
    }
  }
  const cacheBits = br.bit() ? br.bits(4) : 0;
  if (cacheBits > 11) throw new Error("bad color cache size");
  const cacheSize = cacheBits ? 1 << cacheBits : 0;
  // Meta-Huffman: which of several code groups each tile of pixels uses.
  let metaImg = null, metaBits = 0, metaW = 0, numGroups = 1;
  if (isLevel0 && br.bit()) {
    metaBits = br.bits(3) + 2;
    metaW = sub(w, metaBits);
    metaImg = decodeImageStream(br, metaW, sub(h, metaBits), false);
    for (let i = 0; i < metaImg.length; i++) {
      const g = (metaImg[i] >> 8) & 0xffff;              // (red<<8)|green
      if (g + 1 > numGroups) numGroups = g + 1;
    }
  }
  const ALPHABETS = [256 + 24 + cacheSize, 256, 256, 256, 40];
  const groups = [];
  for (let g = 0; g < numGroups; g++) groups.push(ALPHABETS.map((a) => readHuffCode(br, a)));

  const n = w * h;
  const pix = new Uint32Array(n);
  const cache = cacheSize ? new Uint32Array(cacheSize) : null;
  const cShift = 32 - cacheBits;
  let pos = 0, x = 0, y = 0;
  let grp = groups[0];
  const tileMask = metaImg ? (1 << metaBits) - 1 : 0;
  const pickGroup = () => {
    if (metaImg) grp = groups[(metaImg[(y >> metaBits) * metaW + (x >> metaBits)] >> 8) & 0xffff];
  };
  pickGroup();
  while (pos < n) {
    const s = huffDecode(grp[0], br);
    if (s < 256) {                                       // literal ARGB
      const r = huffDecode(grp[1], br), b = huffDecode(grp[2], br), a = huffDecode(grp[3], br);
      const p = ((a << 24) | (r << 16) | (s << 8) | b) >>> 0;
      pix[pos++] = p;
      if (cache) cache[Math.imul(p, 0x1e35a7bd) >>> cShift] = p;
      if (++x === w) { x = 0; y++; }
      if ((x & tileMask) === 0) pickGroup();
    } else if (s < 280) {                                // back reference
      const length = prefixVal(s - 256, br);
      const dist = planeToDist(prefixVal(huffDecode(grp[4], br), br), w);
      if (dist > pos || pos + length > n) throw new Error("bad back reference");
      for (let i = 0; i < length; i++) {
        const p = pix[pos - dist];
        pix[pos++] = p;
        if (cache) cache[Math.imul(p, 0x1e35a7bd) >>> cShift] = p;
        if (++x === w) { x = 0; y++; }
      }
      if (pos < n) pickGroup();
    } else {                                             // color cache hit
      if (!cache) throw new Error("cache hit without cache");
      pix[pos++] = cache[s - 280];
      if (++x === w) { x = 0; y++; }
      if ((x & tileMask) === 0) pickGroup();
    }
  }
  // Undo transforms, most recent first.
  for (let t = transforms.length - 1; t >= 0; t--) {
    const tr = transforms[t];
    if (tr.type === 2) subtractGreenInverse(pix);
    else if (tr.type === 0) predictorInverse(pix, w, h, tr);
    else if (tr.type === 1) colorInverse(pix, w, h, tr);
    else { const out = paletteInverse(pix, w, h, tr); w = tr.unpackedW; return out; }
  }
  return pix;
}

function subtractGreenInverse(pix) {
  for (let i = 0; i < pix.length; i++) {
    const p = pix[i], g = (p >> 8) & 0xff;
    const r = ((p >> 16) + g) & 0xff, b = (p + g) & 0xff;
    pix[i] = ((p & 0xff00ff00) | (r << 16) | b) >>> 0;
  }
}

const int8 = (v) => (v << 24) >> 24;
const ctd = (t, c) => (int8(t) * int8(c)) >> 5;          // color transform delta
function colorInverse(pix, w, h, tr) {
  const { sizeBits, tw, tiles } = tr;
  for (let y = 0; y < h; y++) {
    const trow = (y >> sizeBits) * tw;
    for (let x = 0; x < w; x++) {
      const m = tiles[trow + (x >> sizeBits)];
      const g2r = m & 0xff, g2b = (m >> 8) & 0xff, r2b = (m >> 16) & 0xff;
      const i = y * w + x, p = pix[i], g = (p >> 8) & 0xff;
      const r = (((p >> 16) & 0xff) + ctd(g2r, g)) & 0xff;
      const b = ((p & 0xff) + ctd(g2b, g) + ctd(r2b, r)) & 0xff;
      pix[i] = ((p & 0xff00ff00) | (r << 16) | b) >>> 0;
    }
  }
}

function paletteInverse(pix, packedW, h, tr) {
  const { pal, size, widthBits, unpackedW } = tr;
  const out = new Uint32Array(unpackedW * h);
  if (widthBits === 0) {
    for (let i = 0; i < pix.length; i++) {
      const idx = (pix[i] >> 8) & 0xff;
      out[i] = idx < size ? pal[idx] : 0;
    }
    return out;
  }
  const perPacked = 1 << widthBits, bitsPer = 8 >> widthBits, mask = (1 << bitsPer) - 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < unpackedW; x++) {
      const packed = (pix[y * packedW + (x >> widthBits)] >> 8) & 0xff;
      const idx = (packed >> ((x & (perPacked - 1)) * bitsPer)) & mask;
      out[y * unpackedW + x] = idx < size ? pal[idx] : 0;
    }
  return out;
}

// Per-channel average without unpacking channels.
const avg2 = (a, b) => ((((a ^ b) & 0xfefefefe) >>> 1) + (a & b)) >>> 0;
const clip255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
function addFull(l, t, tl) {
  let out = 0;
  for (let s = 0; s < 32; s += 8)
    out |= clip255(((l >>> s) & 0xff) + ((t >>> s) & 0xff) - ((tl >>> s) & 0xff)) << s;
  return out >>> 0;
}
function addHalf(l, t, tl) {
  const ave = avg2(l, t);
  let out = 0;
  for (let s = 0; s < 32; s += 8) {
    const a = (ave >>> s) & 0xff, b = (tl >>> s) & 0xff;
    const d = a - b;
    out |= clip255(a + (d >= 0 ? d >> 1 : -((-d) >> 1))) << s;   // trunc toward 0
  }
  return out >>> 0;
}
function select(l, t, tl) {
  // Whichever of L and T the implied gradient is closer to; ties go to T.
  let pl = 0, pt = 0;
  for (let s = 0; s < 32; s += 8) {
    const li = (l >>> s) & 0xff, ti = (t >>> s) & 0xff, ci = (tl >>> s) & 0xff;
    pl += Math.abs(ti - ci);
    pt += Math.abs(li - ci);
  }
  return pl < pt ? l : t;
}
function predictorInverse(pix, w, h, tr) {
  const { sizeBits, tw, tiles } = tr;
  for (let y = 0; y < h; y++) {
    const trow = (y >> sizeBits) * tw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let pred;
      if (y === 0) pred = x === 0 ? 0xff000000 : pix[i - 1];         // L
      else if (x === 0) pred = pix[i - w];                           // T
      else {
        const mode = (tiles[trow + (x >> sizeBits)] >> 8) & 0xff;
        const L = pix[i - 1], T = pix[i - w], TL = pix[i - w - 1];
        // TR of the last column is, by the format's layout, the first pixel
        // of the current row — the plain linear index does that on its own.
        const TR = pix[i - w + 1];
        switch (mode) {
          case 0: pred = 0xff000000; break;
          case 1: pred = L; break;
          case 2: pred = T; break;
          case 3: pred = TR; break;
          case 4: pred = TL; break;
          case 5: pred = avg2(avg2(L, TR), T); break;
          case 6: pred = avg2(L, TL); break;
          case 7: pred = avg2(L, T); break;
          case 8: pred = avg2(TL, T); break;
          case 9: pred = avg2(T, TR); break;
          case 10: pred = avg2(avg2(L, TL), avg2(T, TR)); break;
          case 11: pred = select(L, T, TL); break;
          case 12: pred = addFull(L, T, TL); break;
          case 13: pred = addHalf(L, T, TL); break;
          default: throw new Error(`bad predictor mode ${mode}`);
        }
      }
      // Residual + prediction, each channel mod 256.
      const p = pix[i];
      pix[i] = ((((p & 0xff00ff00) + (pred & 0xff00ff00)) & 0xff00ff00)
        | (((p & 0x00ff00ff) + (pred & 0x00ff00ff)) & 0x00ff00ff)) >>> 0;
    }
  }
}

// ------------------------------------------------------------- container
export function decodeWebP(buf) {
  if (buf.length < 20 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP")
    throw new Error("not a WebP");
  let off = 12;
  while (off + 8 <= buf.length) {
    const four = buf.toString("latin1", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (four === "VP8L") {
      const data = buf.subarray(off + 8, off + 8 + size);
      if (data[0] !== 0x2f) throw new Error("bad VP8L signature");
      const br = new Br(data.subarray(1));
      const w = br.bits(14) + 1, h = br.bits(14) + 1;
      br.bit();                                          // alpha hint
      if (br.bits(3) !== 0) throw new Error("bad VP8L version");
      return { w, h, pix: decodeImageStream(br, w, h, true) };
    }
    if (four === "VP8 ") throw new Error("lossy VP8 — the repo policy is lossless; convert with games2/scripts/to-webp.py");
    off += 8 + size + (size & 1);
  }
  throw new Error("no VP8L chunk");
}

// ---------------------------------------------------------- measurement
// Union of every frame's opaque pixels, in frame-local coordinates — the same
// numbers the retired Python tool produced (alpha > 8, frames sliced off the
// left of the strip, extra columns beyond frames*fw ignored).
export const ALPHA = 8;
export function contentBounds(fileOrBuf, fw, frames) {
  const buf = typeof fileOrBuf === "string" ? readFileSync(fileOrBuf) : fileOrBuf;
  const { w, h, pix } = decodeWebP(buf);
  if (fw <= 0 || w < fw) return null;
  const n = Math.max(1, Math.min(frames || 1, Math.floor(w / fw)));
  let x0 = fw, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let f = 0; f < n; f++) {
      const base = row + f * fw;
      for (let x = 0; x < fw; x++)
        if (pix[base + x] >>> 24 > ALPHA) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    }
  }
  if (x1 < 0) return null;                               // fully transparent
  return { bb: [x0, y0, x1 + 1, y1 + 1], h };
}

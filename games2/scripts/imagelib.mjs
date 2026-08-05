// FORMAT-AGNOSTIC IMAGE READS for the manifest builders (games agent, 2026-07-31).
//
// WHY THIS EXISTS: the art domains are migrating PNG -> lossless WebP (~128 MB
// of art -> ~69 MB; a cold load's 12.8 MB of art -> ~6.3 MB). The builders in
// this directory are the blocker: they hand-parse the PNG IHDR and decode
// pixels with pngjs, and they measure the foot plants, shoulder waterlines and
// monster contact anchors the game RENDERS with. If they silently misread a
// WebP, shadows detach and characters float. So the format dispatch lives here,
// in one place, with one rule:
//
//   THE PNG PATHS ARE BYTE-FOR-BYTE THE ORIGINALS. They were moved here
//   verbatim, not rewritten. A repo full of PNGs produces exactly the manifest
//   it produced before this file existed. The only new code is the WebP branch.
//
// WHY LOSSLESS WEBP IS SAFE HERE, measured not assumed: decoding all 384
// monster walk/idle strips as lossless WebP gives pixels IDENTICAL to decoding
// the PNG originals — 384/384, zero differing bytes. Every anchor, every foot
// plant, every shoulder line therefore comes out the same number. The gate that
// keeps it that way is server/test/imagelib.test.ts.
//
// WHY @cwasm/webp AND NOT sharp: these builders are SYNCHRONOUS top to bottom
// (measureWalkArt loops over strips inline), and sharp is async-only — adopting
// it would mean threading async through the measurement code, which is exactly
// the code that must not change. @cwasm/webp is a synchronous WASM libwebp:
// 120 KB (vs sharp's 28 MB of native binaries), no native build to go wrong on
// node:22-slim, and MEASURED 4.7x FASTER than the pngjs path it joins —
// 384 strips in 319 ms vs 1,494 ms. The manifest build gets quicker as the art
// converts, which is the point: this migration must not slow development down.
//
// MIGRATION IS INCREMENTAL BY DESIGN. 25,356 files across five domains owned by
// five different agents will not convert atomically, so every lookup here
// accepts EITHER extension and `resolveImg` will follow a path whose recorded
// extension has gone stale (a strip converted to .webp while monster.json still
// says .png resolves fine, and vice versa). Nothing has to land in order.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import * as cwebp from "@cwasm/webp";

/** Extensions the builders accept for art, in preference order. */
export const IMG_EXTS = ["png", "webp"];

const IMG_RE = /\.(png|webp)$/i;

/** True for a filename the builders can read. */
export function isImg(name) {
  return IMG_RE.test(name);
}

/**
 * Resolve a path whose EXTENSION MAY BE STALE. Tries the path as given, then
 * the same basename with each other known extension. Returns null if none
 * exists. This is what makes the PNG->WebP migration order-independent: a
 * manifest/monster.json entry still saying ".png" keeps working the moment the
 * file becomes ".webp", and a half-converted directory never silently drops art.
 */
export function resolveImg(p) {
  if (existsSync(p)) return p;
  const stem = p.replace(IMG_RE, "");
  if (stem === p) return null; // not an image path at all
  for (const ext of IMG_EXTS) {
    const cand = `${stem}.${ext}`;
    if (cand !== p && existsSync(cand)) return cand;
  }
  return null;
}

/** `<dir>/<base>.<ext>` for whichever extension is present, else null. */
export function findImg(dir, base) {
  for (const ext of IMG_EXTS) {
    const p = join(dir, `${base}.${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Count NUMBERED frames (0.png / 0.webp / …) in a frame folder. */
export function countFrames(dir) {
  if (!existsSync(dir)) return 0;
  const seen = new Set();
  for (const f of readdirSync(dir)) {
    const m = /^(\d+)\.(png|webp)$/i.exec(f);
    if (m) seen.add(m[1]);
  }
  return seen.size;
}

// --- dimensions, header-only (no pixel decode) -----------------------------

/** PNG [width, height] from IHDR. VERBATIM from build-manifest.mjs. */
function pngDims(b) {
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/**
 * WebP [width, height] from the RIFF header — no decode. Handles the three
 * chunk kinds a converter can emit:
 *   VP8L  lossless (what a `-lossless` conversion produces): 14-bit w-1/h-1
 *         packed little-endian after the 0x2f signature byte.
 *   VP8X  extended (set when the file carries an ICC profile / EXIF / anim):
 *         24-bit canvas w-1/h-1.
 *   VP8   lossy keyframe: 14-bit w/h after the 0x9d 0x01 0x2a start code.
 * Verified against a full decode for every file the gate converts — a
 * hand-rolled header parser is exactly the thing that misreads silently, so it
 * is asserted rather than trusted.
 */
function webpDims(b) {
  // MINIMUM LENGTHS ARE PER-BRANCH, not one blanket number. A FULLY TRANSPARENT
  // frame encodes to a 28-BYTE VP8L file (measured: 48x48, 64x64 and 112x112 all
  // land on 28 bytes) — perfectly valid, and common in die/fade animations; the
  // wiki agent found 13 such frames in 905 sprites. This function originally
  // required 30 bytes up front and threw "not a WebP file" on every one of them,
  // which would have crashed the monster manifest build outright
  // (build-monsters-manifest.mjs calls imgDims per strip with no try/catch).
  // Never re-introduce a blanket size guard: "too small to be real" is false for
  // WebP.
  if (b.length < 16 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP")
    throw new Error("not a WebP file");
  const fourcc = b.toString("ascii", 12, 16);
  if (fourcc === "VP8L" && b.length >= 25) {
    if (b[20] !== 0x2f) throw new Error("bad VP8L signature");
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (fourcc === "VP8X" && b.length >= 30) {
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return [w + 1, h + 1];
  }
  if (fourcc === "VP8 " && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw new Error("bad VP8 start code");
    return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  throw new Error(`unreadable WebP header (chunk ${fourcc}, ${b.length}B)`);
}

/**
 * [width, height] of a PNG or WebP.
 *
 * The header parse is a FAST PATH, never the only path: any WebP shape it does
 * not recognise falls back to a full decode, which is slower but cannot be
 * wrong. Callers (build-manifest for frame size, build-monsters-manifest for
 * per-strip stripDims) have no try/catch, so a throw here fails the whole
 * manifest build — correctness outranks the microseconds.
 */
export function imgDims(p) {
  const b = readFileSync(p);
  if (b.length >= 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return pngDims(b);
  try {
    return webpDims(b);
  } catch {
    const d = cwebp.decode(b); // authoritative; throws only on genuinely bad data
    return [d.width, d.height];
  }
}

// --- pixel access ----------------------------------------------------------

/**
 * Minimal PNG decode (8-bit RGBA/RGB, non-interlaced — what PixelLab emits)
 * returning an alpha-test function. VERBATIM from build-manifest.mjs, including
 * the `> 64` alpha threshold and the RGB-means-always-opaque rule; do not
 * "clean this up", the measured anchors depend on it exactly.
 */
function pngAlphaFrom(b) {
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
      const a = i >= channels ? out[i - channels] : 0; // left
      const bb = prev ? prev[i] : 0; // up
      const c = prev && i >= channels ? prev[i - channels] : 0; // up-left
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
  const opaque = (x, y) => (colorType === 2 ? true : img[y * stride + x * channels + 3] > 64);
  return { w, h, opaque };
}

/** WebP -> the SAME { w, h, opaque } contract, same `> 64` alpha threshold.
 * @cwasm/webp always hands back RGBA, so there is no colorType special case. */
function webpAlphaFrom(b) {
  const { width: w, height: h, data } = cwebp.decode(b);
  const opaque = (x, y) => data[(y * w + x) * 4 + 3] > 64;
  return { w, h, opaque };
}

/**
 * `{ w, h, opaque(x,y) }` for a PNG or WebP, or null when the format is one the
 * PNG fast-path refuses (16-bit, palette, interlaced) — callers already treat
 * null as "skip this frame".
 */
export function imgAlpha(p) {
  const b = readFileSync(p);
  if (b.length >= 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") return pngAlphaFrom(b);
  try {
    return webpAlphaFrom(b);
  } catch {
    return null;
  }
}

/**
 * Full RGBA pixels: `{ width, height, data }` where data is 4 bytes per pixel,
 * row-major, unpremultiplied — the shape build-monsters-manifest.mjs already
 * consumed from pngjs. PNG still goes through pngjs (byte-identical to before);
 * WebP goes through @cwasm/webp, which was verified to produce the identical
 * buffer for all 384 shipped monster strips.
 */
export function imgRGBA(p) {
  const b = readFileSync(p);
  if (b.length >= 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG") {
    const png = PNG.sync.read(b);
    return { width: png.width, height: png.height, data: png.data };
  }
  const d = cwebp.decode(b);
  return { width: d.width, height: d.height, data: d.data };
}

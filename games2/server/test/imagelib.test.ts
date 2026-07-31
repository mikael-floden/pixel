// THE WEBP MIGRATION GATE.
//
// The art domains are converting ~25,000 files from PNG to lossless WebP. The
// manifest builders measure the foot plants, shoulder waterlines and monster
// contact anchors the game RENDERS with — if they misread a WebP by even one
// pixel, shadows detach from feet and characters float. scripts/imagelib.mjs is
// the single dispatch point that makes that safe; this test is what keeps it
// safe.
//
// It asserts the property the whole migration rests on:
//   a lossless WebP and its PNG original are INDISTINGUISHABLE to every read
//   the builders perform.
//
// The fixtures are real character frames committed in both formats:
//   0.png + 0.webp  the same frame twice — the pixel-equivalence pair, and the
//                   "a half-converted folder must not count frame 0 twice" case
//   1.webp          webp only — stale-extension resolution and webp-only discovery
// Committing them rather than converting at test time is deliberate: no encoder
// dependency, deterministic, and it pins the exact bytes these assertions were
// written against.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error — plain .mjs helper shared with the build scripts
import { imgDims, imgAlpha, imgRGBA, resolveImg, findImg, countFrames, isImg } from "../../scripts/imagelib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const PNG_FILE = join(FIX, "0.png");
const WEBP_FILE = join(FIX, "0.webp");

test("imagelib: WebP header dims match the PNG original", () => {
  const [pw, ph] = imgDims(PNG_FILE);
  const [ww, wh] = imgDims(WEBP_FILE);
  assert.ok(pw > 0 && ph > 0, "png dims are sane");
  assert.equal(ww, pw, "webp width matches");
  assert.equal(wh, ph, "webp height matches");
});

test("imagelib: WebP header dims match a FULL decode (the parser cannot silently misread)", () => {
  // imgDims parses the RIFF/VP8L header by hand for speed. A hand-rolled parser
  // is exactly the thing that returns a plausible wrong number, so check it
  // against the decoder that actually produces the pixels.
  const [hw, hh] = imgDims(WEBP_FILE);
  const dec = imgRGBA(WEBP_FILE);
  assert.equal(hw, dec.width, "header width == decoded width");
  assert.equal(hh, dec.height, "header height == decoded height");
  assert.equal(dec.data.length, dec.width * dec.height * 4, "RGBA buffer is 4 bytes/px");
});

test("imagelib: the ALPHA channel is bit-identical PNG vs lossless WebP", () => {
  // This is the load-bearing claim. Both builders read ONLY alpha
  // (build-monsters-manifest: data[...*4+3] > 16; build-manifest: opaque()
  // > 64), so if alpha survives the conversion exactly, every measured anchor,
  // foot plant and shoulder line is unchanged by definition.
  const a = imgRGBA(PNG_FILE);
  const b = imgRGBA(WEBP_FILE);
  assert.equal(b.width, a.width);
  assert.equal(b.height, a.height);
  let differing = 0;
  for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) differing++;
  assert.equal(differing, 0, "every alpha byte survives lossless conversion");
});

test("imagelib: VISIBLE colour is bit-identical PNG vs lossless WebP", () => {
  // RGB *under fully transparent pixels* is allowed to differ — it is invisible
  // and lossless WebP encoders normalise it to compress better (measured: 33 of
  // 125 sample files, alpha never affected). Anything visible must be exact.
  const a = imgRGBA(PNG_FILE);
  const b = imgRGBA(WEBP_FILE);
  let visibleDiff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i + 3] === 0 && b.data[i + 3] === 0) continue; // invisible pixel
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2])
      visibleDiff++;
  }
  assert.equal(visibleDiff, 0, "no visible pixel changes colour");
});

test("imagelib: opaque() — the builders' actual read — agrees on every pixel", () => {
  const a = imgAlpha(PNG_FILE);
  const b = imgAlpha(WEBP_FILE);
  assert.ok(a && b, "both formats decode to an alpha tester");
  assert.equal(b.w, a.w);
  assert.equal(b.h, a.h);
  let mismatches = 0;
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) if (a.opaque(x, y) !== b.opaque(x, y)) mismatches++;
  assert.equal(mismatches, 0, "silhouette is identical, so every measurement is");
});

test("imagelib: resolveImg follows a STALE extension in either direction", () => {
  // monster.json / world.json are other agents' files. During the migration they
  // can still name a .png that is now a .webp (or the reverse). Without this the
  // strip silently disappears and a monster loses a whole facing.
  assert.equal(resolveImg(PNG_FILE), PNG_FILE, "an existing path is returned untouched");
  assert.equal(resolveImg(join(FIX, "1.png")), join(FIX, "1.webp"), "stale .png follows to the real .webp");
  assert.equal(resolveImg(join(FIX, "9.webp")), null, "a genuinely missing frame is still null");
});

test("imagelib: discovery accepts both extensions", () => {
  assert.ok(isImg("0.png") && isImg("12.webp"), "both extensions are art");
  assert.ok(!isImg("notes.txt"), "non-art is rejected");
  assert.equal(findImg(FIX, "1"), join(FIX, "1.webp"), "findImg locates a webp-only frame");
  // countFrames must not double-count a frame present in BOTH formats
  // mid-conversion, or the client asks for frames the animation does not have.
  assert.equal(countFrames(FIX), 2, "0.{png,webp} + 1.webp == 2 distinct frames, not 3");
});

test("imagelib: a WebP really is smaller (the point of the migration)", () => {
  const png = readFileSync(PNG_FILE).length;
  const webp = readFileSync(WEBP_FILE).length;
  assert.ok(webp < png, `webp ${webp}B < png ${png}B`);
});

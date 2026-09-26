/// <reference lib="dom" />
/* THE BOUNDARY ON THE GPU (maintainer 2026-09-26: "we need to both do this and
 * try the GPU transition/boundary render shader again ... The boundary shader
 * needs a test to make sure it produced the same tile we get when the CPU
 * produces it!").
 *
 * A composed boundary (tiles3draw `buildBoundaryPixels` + `withEdge`) splits
 * into two things of very different kinds:
 *   - its SHAPE — for every output texel, which composite texel it copies (the
 *     top face's margin row and a capped wall copy their column's bottom
 *     surface texel), its final alpha (the silhouette, the top face, the cut
 *     above a back edge's line), and whether the outline inks it (outer, inner).
 *     That is geometry: it depends on (topOnly, the outline code) and never on
 *     the art;
 *   - its COLOURS — two plates, a Wang mask frame and the seam.
 * The shape is taken from the CPU code ITSELF (`shapeOf`): the real
 * `buildBoundaryPixels` and `withEdge` run once per shape over synthetic plates
 * whose texels are their own coordinates, so whatever the CPU pipeline does to
 * a raster's geometry, the shape says exactly that — a change there cannot
 * leave this behind. The colours are three batched GPU passes:
 *   A. the composite: per output texel, the plate the mask picks at its source
 *      texel, the seam through a 256-entry table of the CPU's own `rint`
 *      (float32 lands on the wrong side of the .5 ties rint exists for);
 *   B. the outline's tone: the sum of the composite over the tile's opaque
 *      texels (the CPU inks in the raster's MEAN colour), exact in integers;
 *   C. the ink, in exact integer arithmetic (see `FRAG_C`).
 * A SLOPE boundary shifts one side down `lift` rows and leaves a hole wherever
 * the side the mask picks has none (tiles3draw `composeBoundary` holes), so its
 * alpha — and everything the outline decides from alpha — depends on the two
 * plates' own alpha too: its shape is taken per (frame, slope, the two plates'
 * identities), over coordinate plates that carry the REAL plates' alpha, and it
 * records which side each texel came from (the GPU then needs no mask).
 *
 * WebGL1, no extensions: every value is an integer stored in RGBA8, every
 * sample is NEAREST at a texel centre. */
import { DX, DY, rampHeight } from "./tiles3";
import type { ComposeOut, GpuPrepReq } from "./composeworker";
type GpuPrepOut = Extract<ComposeOut, { type: "gpuplate" | "gpushape" | "gpurshape" | "gpumiss" }>;
import {
  buildBoundaryPixels,
  buildPlatePixels,
  buildRampPixels,
  edgeTopPixels,
  withEdge,
  rint,
  newPixels,
  EDGE_ALPHA,
  EDGE_ALPHA_IN,
  EDGE_SHADE,
  EDGE_SHADE_IN,
  type ComposeJob,
  type ComposeSide,
  type RampJob,
  type PatternSheets,
  type Pixels,
} from "./tiles3draw";

export type BoundaryJob = Extract<ComposeJob, { kind: "boundary" }>;

/** Can the GPU compose this job? (A missing mask frame cannot.) */
export function supported(j: BoundaryJob): boolean {
  return typeof j.frame === "number" && j.frame >= 0;
}

/* -- the shape, from the CPU's own code ------------------------------------ */

/** A shape: fw*fh texels, RGBA = (source x, source y, ink class, final alpha).
 *  Ink class 0 none, 1 outer line, 2 inner line, 3 cut by the outline (alpha 0,
 *  the composite's rgb kept — the CPU clears alpha only). A texel with final
 *  alpha 0 and class 0 is (0,0,0,0). */
export type Shape = Uint8Array;

const shapeMemo = new WeakMap<PatternSheets, Map<string, Shape>>();

type ShapeJob = Pick<BoundaryJob, "topOnly" | "noWall" | "edge" | "slope" | "frame" | "a" | "b">;
const sideId = (s: BoundaryJob["a"]) => `${s.kind}:${s.path}:${s.topOnly ? 1 : 0}:${s.rise ?? 0}`;
export function shapeKey(j: ShapeJob): string {
  const base = `${j.topOnly ? 1 : 0}|${j.noWall ? 1 : 0}|${j.edge ?? ""}`;
  if (!j.slope) return base;
  return `${base}|s${j.slope.side}${j.slope.rise},${j.slope.lift}|f${j.frame}|${sideId(j.a)}|${sideId(j.b)}`;
}

/** The probe tone: a uniform grey the outline's two inks move to two known
 *  values (outer 122, inner 164) — anything else is "not inked". */
const PROBE = 200;

export function shapeOf(sheets: PatternSheets, j: ShapeJob, pa?: Pixels, pb?: Pixels): Shape {
  let m = shapeMemo.get(sheets);
  if (!m) shapeMemo.set(sheets, (m = new Map()));
  const key = shapeKey(j);
  const hit = m.get(key);
  if (hit) return hit;
  const { fw, fh } = sheets;
  // Two plates whose every texel IS its coordinate: whichever side the mask
  // picks, the composite at (x, y) reads (x, y). The seam is off: it would
  // scale the coordinates (the GPU applies it at the source texel itself).
  // A slope: blue marks the side (1 = a, 2 = b) and alpha is the real plate's,
  // so the holes and the shift land exactly where the CPU puts them.
  if (j.slope && (!pa || !pb)) throw new Error("tiles3gpu: a slope's shape needs its two plates");
  const coordOf = (side: number, alpha?: Pixels) => {
    const c = newPixels(fw, fh);
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const i = (y * fw + x) * 4;
        c.data[i] = x;
        c.data[i + 1] = y;
        c.data[i + 2] = side;
        c.data[i + 3] = alpha ? alpha.data[i + 3] : 255;
      }
    return c;
  };
  const pre = j.slope
    ? buildBoundaryPixels(sheets, { maskFrame: j.frame, topOnly: j.topOnly, noWall: j.noWall, slope: j.slope }, coordOf(1, pa), coordOf(2, pb), false)
    : buildBoundaryPixels(sheets, { maskFrame: 0, topOnly: j.topOnly, noWall: j.noWall }, coordOf(0), coordOf(0), false);
  // The outline over a uniform raster of the same alpha: its cuts are alpha,
  // its lines move the grey to one of two values.
  const grey: Pixels = { w: pre.w, h: pre.h, data: new Uint8ClampedArray(pre.data) };
  for (let i = 0; i < grey.data.length; i += 4) if (grey.data[i + 3] > 0) grey.data[i] = grey.data[i + 1] = grey.data[i + 2] = PROBE;
  const post = withEdge(sheets, grey, j.edge);
  const outer = Math.round(PROBE * (1 - EDGE_ALPHA) + PROBE * EDGE_SHADE * EDGE_ALPHA);
  const inner = Math.round(PROBE * (1 - EDGE_ALPHA_IN) + PROBE * EDGE_SHADE_IN * EDGE_ALPHA_IN);
  const s = new Uint8Array(fw * fh * 4);
  for (let i = 0; i < fw * fh; i++) {
    const a0 = pre.data[i * 4 + 3];
    const a1 = post.data[i * 4 + 3];
    if (a0 === 0) continue; // (0,0,0,0): nothing there before the outline either
    s[i * 4] = pre.data[i * 4];
    s[i * 4 + 1] = pre.data[i * 4 + 1];
    const v = post.data[i * 4];
    const cls = a1 === 0 ? 3 : v === outer ? 1 : v === inner ? 2 : v === PROBE ? 0 : 255;
    s[i * 4 + 2] = cls === 255 ? 255 : cls + 4 * pre.data[i * 4 + 2]; // + the side (slopes)
    s[i * 4 + 3] = a1;
    if (cls === 255) throw new Error(`tiles3gpu: shape ${key} texel ${i} inked to ${v}, neither line`);
  }
  m.set(key, s);
  return s;
}

/** A mask frame as a texture tile: R = the mask bit, G = the seam bit (255/0). */
function frameTile(sheets: PatternSheets, frame: number): Uint8Array {
  const { fw, fh } = sheets;
  const out = new Uint8Array(fw * fh * 4);
  for (let y = 0; y < fh; y++)
    for (let x = 0; x < fw; x++) {
      const i = (y * fw + x) * 4;
      out[i] = sheets.maskBit(frame, x, y) ? 255 : 0;
      out[i + 1] = sheets.borderBit(frame, x, y) ? 255 : 0;
      out[i + 3] = 255;
    }
  return out;
}

/* -- the shaders ------------------------------------------------------------ */

const VERT = `
precision highp float;
attribute vec2 aPos;    // destination, in target texels
attribute vec2 aLocal;  // the tile's own texel coordinate (0..fw, 0..fh)
attribute vec4 aA;      // plate A origin (xy), plate B origin (zw), in plate-atlas texels
attribute vec4 aB;      // shape origin (xy), frame origin (zw), in shape/frame-atlas texels
attribute vec2 aC;      // composite origin in the composite target (pass B, C); seam flag
attribute vec2 aD;      // a slope's lift and shifted side
uniform vec2 uTarget;
varying vec2 vLocal;
varying vec4 vA;
varying vec4 vB;
varying vec2 vC;
varying vec2 vD;
void main() {
  vLocal = aLocal; vA = aA; vB = aB; vC = aC; vD = aD;
  gl_Position = vec4(aPos / uTarget * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `
precision highp float;
uniform sampler2D uPlates; uniform vec2 uPlatesSize;
uniform sampler2D uShapes; uniform vec2 uShapesSize;
uniform sampler2D uFrames; uniform vec2 uFramesSize;
uniform sampler2D uTone;   // 256x1: the CPU's rint(v * tone)
uniform sampler2D uComp; uniform vec2 uCompSize;
uniform sampler2D uSums; uniform vec2 uSumsSize;
varying vec2 vLocal;
varying vec4 vA;
varying vec4 vB;
varying vec2 vC;
varying vec2 vD;
vec4 at(sampler2D t, vec2 size, vec2 px) { return texture2D(t, (px + 0.5) / size); }
float b8(float v) { return floor(v * 255.0 + 0.5); }
vec4 bytes(vec4 v) { return floor(v * 255.0 + 0.5); }
`;

/** A: the composite at the shape's source texel, final alpha from the shape;
 *  written as bytes. The ink class rides along in nothing: C reads the shape. */
const FRAG_A = COMMON + `
uniform float uFH;
// vD: a slope: lift rows, and which side is shifted (1 a, 2 b, 0 none)
void main() {
  vec2 l = floor(vLocal);
  vec4 s = bytes(at(uShapes, uShapesSize, vB.xy + l));
  float cls = mod(s.z, 4.0), side = floor(s.z / 4.0);
  if (s.w == 0.0 && cls != 3.0) { gl_FragColor = vec4(0.0); return; }
  vec2 src = s.xy; // the PLATE texel (a shifted side's own coordinate)
  bool useB;
  vec4 f;
  if (side == 0.0) {
    f = bytes(at(uFrames, uFramesSize, vB.zw + src));
    useB = f.x > 127.0;
  } else {
    // the seam is sampled where composeBoundary sampled it: the compose row,
    // lift rows up (clamped); a shifted side's compose row is its plate row + lift
    useB = side == 2.0;
    float row = side == vD.y ? src.y : clamp(src.y - vD.x, 0.0, uFH - 1.0);
    f = bytes(at(uFrames, uFramesSize, vB.zw + vec2(src.x, row)));
  }
  vec4 p = useB ? at(uPlates, uPlatesSize, vA.zw + src) : at(uPlates, uPlatesSize, vA.xy + src);
  vec3 rgb = bytes(p).rgb;
  if (vC.y > 0.5 && f.y > 127.0) {
    rgb = vec3(b8(at(uTone, vec2(256.0, 1.0), vec2(rgb.r, 0.0)).r),
               b8(at(uTone, vec2(256.0, 1.0), vec2(rgb.g, 0.0)).r),
               b8(at(uTone, vec2(256.0, 1.0), vec2(rgb.b, 0.0)).r));
  }
  gl_FragColor = vec4(rgb, s.w) / 255.0;
}`;

/** B: three texels per tile — the sums of the composite's r, g, b and the count
 *  of opaque texels, each a 24-bit integer as three bytes: texel 0 = r's bytes
 *  and n's low byte, texel 1 = g's and n's middle, texel 2 = b's and n's high.
 *  Sums reach 2012 x 255 = 513,060 < 2^24: exact in float32. */
const FRAG_B = COMMON + `
void main() {
  float part = floor(vLocal.x);
  float sr = 0.0, sg = 0.0, sb = 0.0, n = 0.0;
  for (int y = 0; y < __FH__; y++) {
    for (int x = 0; x < __FW__; x++) {
      vec2 l = vec2(float(x), float(y));
      vec4 c = bytes(at(uComp, uCompSize, vC.xy + l));
      if (c.w > 0.0) { sr += c.r; sg += c.g; sb += c.b; n += 1.0; }
    }
  }
  float v = part < 0.5 ? sr : (part < 1.5 ? sg : sb);
  float nb = part < 0.5 ? mod(n, 256.0) : (part < 1.5 ? mod(floor(n / 256.0), 256.0) : floor(n / 65536.0));
  gl_FragColor = vec4(mod(v, 256.0), mod(floor(v / 256.0), 256.0), floor(v / 65536.0), nb) / 255.0;
}`;

/** C: the ink, EXACTLY as the CPU's `inkAt` rounds it: out = round(d(1-a) +
 *  (S/n)·shade·a). With the published constants that is, for the outer line,
 *  0.4·d + 0.21·S/n and for the inner 0.55·d + 0.27·S/n — split into integer
 *  parts and exact remainders so no float32 product ever leaves 2^24:
 *    0.4d  = floor(2d/5)   + (2d mod 5)/5
 *    0.55d = floor(11d/20) + (11d mod 20)/20
 *    q·S/(100n) = floor(..) + r/(100n)       (q = 21 or 27; qS < 2^24)
 *  and the fractions are compared against 1/2 in integers. */
const FRAG_C = COMMON + `
uniform vec4 uInk; // outer: (d numerator, d denominator, S factor); inner in uInk2
uniform vec4 uInk2;
uniform float uPma;
// what Phaser's upload stores (UNPACK_PREMULTIPLY_ALPHA): rgb*a/255 rounded half up
vec4 pma(vec4 c) {
  if (uPma < 0.5) return c;
  if (c.w == 0.0) return vec4(0.0);
  if (c.w == 255.0) return c;
  return vec4(floor((c.rgb * c.w + 127.5) / 255.0), c.w);
}
float sum24(vec4 t) { return t.x + t.y * 256.0 + t.z * 65536.0; }
float ink(float d, float S, float n, vec4 k) {
  // d * k.x / k.y  +  S * k.z / (100 n), rounded half up
  float dn = d * k.x;
  float q1 = floor(dn / k.y);
  float r1 = dn - q1 * k.y;
  if (r1 < 0.0) { q1 -= 1.0; r1 += k.y; }
  if (r1 >= k.y) { q1 += 1.0; r1 -= k.y; }
  float num = S * k.z;
  float den = 100.0 * n;
  float q2 = floor(num / den);
  float r2 = num - q2 * den;
  if (r2 < 0.0) { q2 -= 1.0; r2 += den; }
  if (r2 >= den) { q2 += 1.0; r2 -= den; }
  // frac = r1/k.y + r2/den ; compare 2*(r1*den + r2*k.y) against k.y*den
  float lhs = 2.0 * (r1 * den + r2 * k.y);
  float rhs = k.y * den;
  // lhs >= 2*rhs means the fractions summed past a whole: one unit, then round
  float whole = lhs >= 2.0 * rhs ? 1.0 : 0.0;
  float rest = lhs - whole * 2.0 * rhs;
  return q1 + q2 + whole + (rest >= rhs ? 1.0 : 0.0);
}
void main() {
  vec2 l = floor(vLocal);
  vec4 c = bytes(at(uComp, uCompSize, vC.xy + l));
  vec4 s = bytes(at(uShapes, uShapesSize, vB.xy + l));
  float cls = mod(s.z, 4.0);
  if (cls != 1.0 && cls != 2.0) { gl_FragColor = pma(c) / 255.0; return; }
  // the tile's sums (pass B), three texels at its index
  vec2 si = vec2(vA.x, 0.0);
  vec4 t0 = bytes(at(uSums, uSumsSize, si));
  vec4 t1 = bytes(at(uSums, uSumsSize, si + vec2(1.0, 0.0)));
  vec4 t2 = bytes(at(uSums, uSumsSize, si + vec2(2.0, 0.0)));
  float n = t0.w + t1.w * 256.0 + t2.w * 65536.0;
  if (n == 0.0) { gl_FragColor = pma(c) / 255.0; return; }
  vec4 k = cls == 1.0 ? uInk : uInk2;
  vec3 o = vec3(ink(c.r, sum24(t0), n, k), ink(c.g, sum24(t1), n, k), ink(c.b, sum24(t2), n, k));
  gl_FragColor = pma(vec4(o, c.w)) / 255.0;
}`;

/* -- the compositor --------------------------------------------------------- */

function compile(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (t: number, src: string) => {
    const s = gl.createShader(t)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`tiles3gpu: shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`tiles3gpu: link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function texture(gl: WebGLRenderingContext, w: number, h: number, data: Uint8Array | null): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** THE COMPOSITOR on a WebGL1 context: `compose` draws a batch of tiles and
 *  reads them back (the parity gate's use; the game's will draw into textures). */
/** A persistent atlas of fixed-size tiles on the GPU: a slot per key, uploaded
 *  ONCE (texSubImage2D of that slot only), never again. Full, it starts over
 *  (every slot is re-uploaded on its next use) — a session never fills the
 *  plate or frame atlas, and the shape atlas holds 1,408 shapes. */
export class SlotAtlas {
  readonly tex: WebGLTexture;
  readonly w: number;
  readonly h: number;
  private slots = new Map<string, number>();
  private readonly cap: number;
  private readonly cols: number;
  constructor(private gl: WebGLRenderingContext, readonly fw: number, readonly fh: number, size = 2048) {
    this.cols = Math.floor(size / fw);
    const rows = Math.floor(size / fh);
    this.cap = this.cols * rows;
    this.w = this.cols * fw;
    this.h = rows * fh;
    this.tex = texture(gl, this.w, this.h, null);
  }
  has(key: string): boolean {
    return this.slots.has(key);
  }
  /** The slot's origin in texels, uploading `data()` the first time. */
  origin(key: string, data: () => Uint8Array): [number, number] {
    let k = this.slots.get(key);
    if (k === undefined) {
      if (this.slots.size >= this.cap) this.slots.clear();
      k = this.slots.size;
      this.slots.set(key, k);
      const [x, y] = this.at(k);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, this.fw, this.fh, gl.RGBA, gl.UNSIGNED_BYTE, data());
      this.uploads++;
    }
    return this.at(k);
  }
  uploads = 0;
  /** `origin` that never evicts: null when the atlas is full. The direct draw
   *  holds slot origins in its instances, so a slot, once given, is never
   *  reused under another key. */
  tryOrigin(key: string, data: () => Uint8Array): [number, number] | null {
    if (!this.slots.has(key) && this.slots.size >= this.cap) return null;
    return this.origin(key, data);
  }
  /** Claim a slot for `key` whose pixels the caller uploads itself (a bulk load). */
  reserve(key: string): [number, number] {
    let k = this.slots.get(key);
    if (k === undefined) {
      if (this.slots.size >= this.cap) throw new Error("tiles3gpu: atlas full at load");
      k = this.slots.size;
      this.slots.set(key, k);
    }
    return this.at(k);
  }
  get size(): number {
    return this.slots.size;
  }
  private at(k: number): [number, number] {
    return [(k % this.cols) * this.fw, Math.floor(k / this.cols) * this.fh];
  }
}

/** THE COMPOSITOR'S STANDING RESOURCES, one set per context, shared by the
 *  boundary and ramp passes: the plates (64x64 slots: a ramp samples the raw
 *  64x64 art), the boundary shapes, the mask/seam frames, the seam table. */
export class GpuShared {
  readonly plates: SlotAtlas;
  readonly shapes: SlotAtlas;
  readonly frames: SlotAtlas;
  readonly tone: WebGLTexture;
  constructor(readonly gl: WebGLRenderingContext, sheets: PatternSheets) {
    const { fw, fh, tone } = sheets;
    this.plates = new SlotAtlas(gl, fw, PLATE_SLOT_H);
    this.shapes = new SlotAtlas(gl, fw, fh);
    this.frames = new SlotAtlas(gl, fw, fh, 2048); // 32 x 44 = 1,408 frames: every pattern's 16 fit
    const lut = new Uint8Array(256 * 4);
    for (let v = 0; v < 256; v++) { lut[v * 4] = rint(v * tone); lut[v * 4 + 3] = 255; }
    this.tone = texture(gl, 256, 1, lut);
  }
  /** EVERY MASK/SEAM FRAME, AT LOAD (maintainer 2026-09-26: "We only have that
   *  many masks. You can upload all masks to the GPU in loading"): the patterns'
   *  frames (pattern.row x 16 Wang indices, ~288), one upload of the whole
   *  atlas, never touched again. */
  preloadFrames(sheets: PatternSheets, frames: readonly number[]): void {
    const { fw, fh } = sheets;
    const a = this.frames;
    const data = new Uint8Array(a.w * a.h * 4);
    for (const f of frames) {
      const [ox, oy] = a.reserve(String(f));
      const t = frameTile(sheets, f);
      for (let y = 0; y < fh; y++) data.set(t.subarray(y * fw * 4, (y + 1) * fw * 4), ((oy + y) * a.w + ox) * 4);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, a.w, a.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    a.uploads++;
  }
  /** A plate's slot, its pixels uploaded the first time (padded to the slot). */
  plate(id: string, px: () => Pixels): [number, number] {
    return this.plates.origin(id, () => padTo(px(), this.plates));
  }
}
/** Plate slots are this tall: the raw art a ramp samples is 64x64. */
const PLATE_SLOT_H = 64;
function padTo(p: Pixels, a: { fw: number; fh: number }): Uint8Array {
  const out = new Uint8Array(a.fw * a.fh * 4);
  const w = Math.min(p.w, a.fw), h = Math.min(p.h, a.fh);
  for (let y = 0; y < h; y++) out.set(p.data.subarray(y * p.w * 4, (y * p.w + w) * 4), y * a.fw * 4);
  return out;
}

/** One tile to compose: the ids and pixels of its two plates (pixels are read
 *  only the first time an id is seen), the job. */
export interface GpuTile {
  a: Pixels;
  b: Pixels;
  job: BoundaryJob;
  /** Plate identities (default: the job's sides) — a plate is uploaded once per id. */
  ia?: string;
  ib?: string;
}

/** Where a composed batch goes: `read` (the parity gate) reads it back; `copy`
 *  hands each tile's rect in the output target to the caller, which copies it
 *  on the GPU (copyTexSubImage2D) into a texture of its own — no readback. */
export type GpuSink = { kind: "read" } | { kind: "copy"; each: (k: number, x: number, y: number) => void };

/** THE COMPOSITOR on a WebGL1 context. EVERYTHING THAT REPEATS STAYS ON THE GPU:
 *  the seam table (once), the mask/seam frames, the shapes and the plates (a
 *  slot each, uploaded the first time it is used — SlotAtlas), the scratch
 *  targets, framebuffer and vertex buffer (made once). A batch uploads only
 *  what it sees for the first time, plus its vertices. */
export class GpuBoundaries {
  private gl: WebGLRenderingContext;
  private pA: WebGLProgram;
  private pB: WebGLProgram;
  private pC: WebGLProgram;
  private buf: WebGLBuffer;
  private fb: WebGLFramebuffer;
  readonly shared: GpuShared;
  private plates: SlotAtlas;
  private shapes: SlotAtlas;
  private frames: SlotAtlas;
  private tone: WebGLTexture;
  private comp: WebGLTexture;
  private out: WebGLTexture;
  private sums: WebGLTexture;
  private verts: Float32Array;
  /** Tiles one batch holds (the scratch targets' size). */
  static readonly BATCH = 128;
  private readonly cols = 32;
  readonly stats = { tiles: 0, batches: 0, ms: 0 };
  constructor(gl: WebGLRenderingContext, private sheets: PatternSheets, shared?: GpuShared) {
    this.gl = gl;
    const { fw, fh, tone } = sheets;
    this.pA = compile(gl, VERT, FRAG_A);
    this.pB = compile(gl, VERT, FRAG_B.replace("__FH__", String(fh)).replace("__FW__", String(fw)));
    this.pC = compile(gl, VERT, FRAG_C);
    this.buf = gl.createBuffer()!;
    this.fb = gl.createFramebuffer()!;
    this.shared = shared ?? new GpuShared(gl, sheets);
    this.plates = this.shared.plates;
    this.shapes = this.shared.shapes;
    this.frames = this.shared.frames;
    this.tone = this.shared.tone;
    const CW = this.cols * fw, CH = Math.ceil(GpuBoundaries.BATCH / this.cols) * fh;
    this.comp = texture(gl, CW, CH, null);
    this.out = texture(gl, CW, CH, null);
    this.sums = texture(gl, GpuBoundaries.BATCH * 3, 1, null);
    this.verts = new Float32Array(GpuBoundaries.BATCH * 6 * 16);
  }
  get uploads(): { plates: number; shapes: number; frames: number } {
    return { plates: this.plates.uploads, shapes: this.shapes.uploads, frames: this.frames.uploads };
  }
  get targetSize(): [number, number] {
    return [this.cols * this.sheets.fw, Math.ceil(GpuBoundaries.BATCH / this.cols) * this.sheets.fh];
  }
  /** Bind the output target for reading (copyTexSubImage2D / readPixels). */
  bindOut(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out, 0);
  }

  /** Compose up to BATCH tiles. `premultiply`: the output as Phaser's texture
   *  upload stores a raster (UNPACK_PREMULTIPLY_ALPHA): rgb·a/255 rounded, and
   *  alpha 0 -> (0,0,0,0). Answers the rasters for a `read` sink, else []. */
  compose(tiles: GpuTile[], sink: GpuSink = { kind: "read" }, premultiply = false): Pixels[] {
    const gl = this.gl, { fw, fh } = this.sheets;
    const N = tiles.length;
    if (!N) return [];
    if (N > GpuBoundaries.BATCH) throw new Error(`tiles3gpu: a batch holds ${GpuBoundaries.BATCH}`);
    const t0 = performance.now();
    const cols = this.cols;
    const u8 = (p: Pixels) => new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength);
    const per = tiles.map((t) => {
      const ia = t.ia ?? `${sideId(t.job.a)}|${t.job.a.wall.join(",")}`;
      const ib = t.ib ?? `${sideId(t.job.b)}|${t.job.b.wall.join(",")}`;
      const pa = this.shared.plate(ia, () => t.a);
      const pb = this.shared.plate(ib, () => t.b);
      const ps = this.shapes.origin(shapeKey(t.job), () => shapeOf(this.sheets, t.job, t.a, t.b));
      const pf = this.frames.origin(String(t.job.frame), () => frameTile(this.sheets, t.job.frame));
      const sl = t.job.slope;
      // the side buildBoundaryPixels shifts down: the OTHER one (b when the slope is a's)
      return { pa, pb, ps, pf, seam: t.job.seam ? 1 : 0, lift: sl?.lift ?? 0, shifted: sl?.lift ? (sl.side === "a" ? 2 : 1) : 0 };
    });
    const [CW, CH] = this.targetSize;
    const org = (k: number) => [(k % cols) * fw, Math.floor(k / cols) * fh];
    const v = this.verts;
    const quads = (rect: (k: number) => [number, number, number, number], lw: number, lh: number, fix: (k: number, row: number[]) => void) => {
      let o = 0;
      for (let k = 0; k < N; k++) {
        const [x0, y0, x1, y1] = rect(k);
        const p = per[k];
        const [cx, cy] = org(k);
        const row = [0, 0, 0, 0, p.pa[0], p.pa[1], p.pb[0], p.pb[1], p.ps[0], p.ps[1], p.pf[0], p.pf[1], cx, cy, p.lift, p.shifted];
        fix(k, row);
        const corner = (x: number, y: number, lx: number, ly: number) => {
          row[0] = x; row[1] = y; row[2] = lx; row[3] = ly;
          v.set(row, o);
          o += 16;
        };
        corner(x0, y0, 0, 0); corner(x1, y0, lw, 0); corner(x0, y1, 0, lh);
        corner(x1, y0, lw, 0); corner(x1, y1, lw, lh); corner(x0, y1, 0, lh);
      }
      return o;
    };
    const run = (prog: WebGLProgram, target: WebGLTexture, tw: number, th: number, count: number, bind: () => void) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      gl.viewport(0, 0, tw, th);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, count), gl.STREAM_DRAW);
      const attr = (name: string, size: number, off: number) => {
        const loc = gl.getAttribLocation(prog, name);
        if (loc < 0) return;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 16 * 4, off * 4);
      };
      attr("aPos", 2, 0); attr("aLocal", 2, 2); attr("aA", 4, 4); attr("aB", 4, 8); attr("aC", 2, 12); attr("aD", 2, 14);
      gl.uniform2f(gl.getUniformLocation(prog, "uTarget"), tw, th);
      const fhLoc = gl.getUniformLocation(prog, "uFH");
      if (fhLoc) gl.uniform1f(fhLoc, fh);
      const tex = (name: string, unit: number, t: WebGLTexture, w: number, h: number) => {
        const loc = gl.getUniformLocation(prog, name);
        if (!loc) return;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(loc, unit);
        const sz = gl.getUniformLocation(prog, name + "Size");
        if (sz) gl.uniform2f(sz, w, h);
      };
      tex("uPlates", 0, this.plates.tex, this.plates.w, this.plates.h);
      tex("uShapes", 1, this.shapes.tex, this.shapes.w, this.shapes.h);
      tex("uFrames", 2, this.frames.tex, this.frames.w, this.frames.h);
      tex("uTone", 3, this.tone, 256, 1);
      tex("uComp", 4, this.comp, CW, CH);
      tex("uSums", 5, this.sums, GpuBoundaries.BATCH * 3, 1);
      bind();
      gl.drawArrays(gl.TRIANGLES, 0, count / 16);
      // unbind the attribute arrays: the context may be shared with a renderer
      for (const name of ["aPos", "aLocal", "aA", "aB", "aC", "aD"]) {
        const loc = gl.getAttribLocation(prog, name);
        if (loc >= 0) gl.disableVertexAttribArray(loc);
      }
    };
    const tileRect = (k: number): [number, number, number, number] => { const [x, y] = org(k); return [x, y, x + fw, y + fh]; };
    // A: composite. aC.y carries the seam flag.
    let n = quads(tileRect, fw, fh, (k, row) => { row[13] = per[k].seam; });
    run(this.pA, this.comp, CW, CH, n, () => {});
    // B: sums, three texels per tile at x = 3k
    n = quads((k) => [3 * k, 0, 3 * k + 3, 1], 3, 1, () => {});
    run(this.pB, this.sums, GpuBoundaries.BATCH * 3, 1, n, () => {});
    // C: ink. aA.x carries the tile's sums texel (3k).
    n = quads(tileRect, fw, fh, (k, row) => { row[4] = 3 * k; });
    run(this.pC, this.out, CW, CH, n, () => {
      // outer: 0.4 d = 2/5 d, 0.21 S/n ; inner: 0.55 d = 11/20 d, 0.27 S/n
      gl.uniform4f(gl.getUniformLocation(this.pC, "uInk"), 2, 5, 21, 0);
      gl.uniform4f(gl.getUniformLocation(this.pC, "uInk2"), 11, 20, 27, 0);
      gl.uniform1f(gl.getUniformLocation(this.pC, "uPma"), premultiply ? 1 : 0);
    });
    const res: Pixels[] = [];
    if (sink.kind === "read") {
      const raw = new Uint8Array(CW * CH * 4);
      gl.readPixels(0, 0, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      for (let k = 0; k < N; k++) {
        const [ox, oy] = org(k);
        const px = newPixels(fw, fh);
        for (let y = 0; y < fh; y++) px.data.set(raw.subarray(((oy + y) * CW + ox) * 4, ((oy + y) * CW + ox + fw) * 4), y * fw * 4);
        res.push(px);
      }
    } else {
      // the output target stays bound for reading: each copy is GPU to GPU
      for (let k = 0; k < N; k++) { const [ox, oy] = org(k); sink.each(k, ox, oy); }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stats.tiles += N;
    this.stats.batches++;
    this.stats.ms += performance.now() - t0;
    return res;
  }
}

/** The ink constants the shader's integer form assumes — a change to the CPU's
 *  outline constants must change FRAG_C with them, and the gate says so. */
export function inkConstantsHold(): boolean {
  const eq = (a: number, b: number) => Math.abs(a - b) < 1e-12;
  return eq(1 - EDGE_ALPHA, 2 / 5) && eq(EDGE_SHADE * EDGE_ALPHA, 0.21) && eq(1 - EDGE_ALPHA_IN, 11 / 20) && eq(EDGE_SHADE_IN * EDGE_ALPHA_IN, 0.27);
}

/* -- the parity gate --------------------------------------------------------- */

/** Every boundary job the compose worker is handed, for the parity gate
 *  (`__ml.gpuParity`); bounded, newest kept. */
export const seenJobs = new Map<string, BoundaryJob>();
export function noteJob(j: ComposeJob): void {
  if (j.kind !== "boundary") return;
  if (seenJobs.size >= 6000) seenJobs.delete(seenJobs.keys().next().value as string);
  seenJobs.set(j.key, j);
}

async function decodeUrl(url: string): Promise<Pixels> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const bmp = await createImageBitmap(await r.blob());
  const cv = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = cv.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { w: id.width, h: id.height, data: new Uint8ClampedArray(id.data) };
}

export interface ParityReport {
  jobs: number;
  unsupported: number;
  failedInputs: number;
  compared: number;
  identical: number;
  tilesDiffering: number;
  texelsDiffering: number;
  maxDiff: number;
  gpuMs: number;
  /** Non-vacuous: opaque texels compared, and texels the outline inked (shape classes 1/2). */
  opaque: number;
  inked: number;
  /** Slope boundaries compared. */
  slopes: number;
  /** Composed ramps compared (lined variants, ramps lifting a transition). */
  ramps: number;
  rampsIdentical: number;
  rampsLined: number;
  rampsOnTransition: number;
  /** Flat tops with their outline (a RampJob with mask LINED_PLATE). */
  linedPlates: number;
  examples: { key: string; texels: number; first: { x: number; y: number; cpu: number[]; gpu: number[] } }[];
}

/** THE GATE: every boundary job seen, composed by the CPU (the worker's own
 *  functions over the same decoded files) and by the GPU, compared byte for
 *  byte — all four channels, every texel, transparent ones included. */
export async function gpuParity(sheets: PatternSheets, max = 4000): Promise<ParityReport> {
  const jobs = [...seenJobs.values()].slice(-max);
  const rep: ParityReport = { jobs: jobs.length, unsupported: 0, failedInputs: 0, compared: 0, identical: 0, tilesDiffering: 0, texelsDiffering: 0, maxDiff: 0, gpuMs: 0, opaque: 0, inked: 0, slopes: 0, ramps: 0, rampsIdentical: 0, rampsLined: 0, rampsOnTransition: 0, linedPlates: 0, examples: [] };
  const src = new Map<string, Promise<Pixels>>();
  const plate = async (s: BoundaryJob["a"]) => {
    let p = src.get(s.url);
    if (!p) src.set(s.url, (p = decodeUrl(s.url)));
    return buildPlatePixels(sheets, { kind: s.kind, path: s.path, topOnly: s.topOnly, rise: s.rise }, await p, s.wall);
  };
  const tiles: GpuTile[] = [];
  const cpu: Pixels[] = [];
  for (const j of jobs) {
    if (!supported(j)) { rep.unsupported++; continue; }
    let a: Pixels, b: Pixels;
    try { [a, b] = await Promise.all([plate(j.a), plate(j.b)]); } catch { rep.failedInputs++; continue; }
    tiles.push({ a, b, job: j });
    cpu.push(withEdge(sheets, buildBoundaryPixels(sheets, { maskFrame: j.frame, topOnly: j.topOnly, noWall: j.noWall, slope: j.slope }, a, b, j.seam), j.edge));
  }
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: false, antialias: false });
  if (!gl) throw new Error("tiles3gpu: no WebGL");
  const gpu = new GpuBoundaries(gl, sheets);
  // THE RAMPS (every ramp the factory asked for, lined variants included)
  {
    const gr = new GpuRamps(gl, sheets, gpu.shared);
    const rt: RampTile[] = [], rc: Pixels[] = [];
    const rawOf = async (s: ComposeSide) => { let p = src.get(s.url); if (!p) src.set(s.url, (p = decodeUrl(s.url))); return p; };
    const plateOfSide = async (s: ComposeSide) => (s.kind === "raw" ? rawOf(s) : plate(s as BoundaryJob["a"]));
    for (const j of [...seenRampJobs.values()].slice(-max)) {
      try {
        const band = await rawOf(j.band);
        const t: RampTile = j.top.kind === "plate" ? { job: j, band, top: await plateOfSide(j.top.side) } : { job: j, band, a: await plate(j.top.job.a), b: await plate(j.top.job.b) };
        rc.push(rampCpu(sheets, t));
        rt.push(t);
      } catch { rep.failedInputs++; }
    }
    const got: Pixels[] = [];
    for (let i = 0; i < rt.length; i += GpuRamps.BATCH) got.push(...gr.compose(rt.slice(i, i + GpuRamps.BATCH)));
    for (let k = 0; k < rt.length; k++) {
      rep.ramps++;
      if (rt[k].job.edge) rep.rampsLined++;
      if (rt[k].job.top.kind === "boundary") rep.rampsOnTransition++;
      if (rt[k].job.mask === LINED_PLATE) rep.linedPlates++;
      const c = rc[k].data, g = got[k].data;
      let n = 0, first: ParityReport["examples"][number]["first"] | null = null;
      if (c.length !== g.length) n = -1;
      else for (let i = 0; i < c.length; i += 4) {
        if (c[i + 3]) rep.opaque++;
        const d = Math.max(Math.abs(c[i] - g[i]), Math.abs(c[i + 1] - g[i + 1]), Math.abs(c[i + 2] - g[i + 2]), Math.abs(c[i + 3] - g[i + 3]));
        if (!d) continue;
        n++;
        rep.maxDiff = Math.max(rep.maxDiff, d);
        if (!first) first = { x: (i / 4) % sheets.fw, y: Math.floor(i / 4 / sheets.fw), cpu: [c[i], c[i + 1], c[i + 2], c[i + 3]], gpu: [g[i], g[i + 1], g[i + 2], g[i + 3]] };
      }
      if (!n) { rep.rampsIdentical++; continue; }
      rep.tilesDiffering++;
      rep.texelsDiffering += Math.max(0, n);
      if (rep.examples.length < 8) rep.examples.push({ key: "ramp " + rt[k].job.key, texels: n, first: first ?? { x: -1, y: -1, cpu: [rc[k].w, rc[k].h], gpu: [got[k].w, got[k].h] } });
    }
    rep.gpuMs += +gr.stats.ms.toFixed(1);
  }
  const out: Pixels[] = [];
  for (let i = 0; i < tiles.length; i += GpuBoundaries.BATCH) out.push(...gpu.compose(tiles.slice(i, i + GpuBoundaries.BATCH)));
  rep.gpuMs += +gpu.stats.ms.toFixed(1);
  for (let k = 0; k < tiles.length; k++) {
    rep.compared++;
    const c = cpu[k].data, g = out[k].data;
    const sh = shapeOf(sheets, tiles[k].job, tiles[k].a, tiles[k].b);
    if (tiles[k].job.slope) rep.slopes++;
    for (let i = 0; i < c.length; i += 4) { if (c[i + 3]) rep.opaque++; if (sh[i + 2] % 4 === 1 || sh[i + 2] % 4 === 2) rep.inked++; }
    let n = 0, first: ParityReport["examples"][number]["first"] | null = null;
    for (let i = 0; i < c.length; i += 4) {
      const d = Math.max(Math.abs(c[i] - g[i]), Math.abs(c[i + 1] - g[i + 1]), Math.abs(c[i + 2] - g[i + 2]), Math.abs(c[i + 3] - g[i + 3]));
      if (!d) continue;
      n++;
      rep.maxDiff = Math.max(rep.maxDiff, d);
      if (!first) first = { x: (i / 4) % sheets.fw, y: Math.floor(i / 4 / sheets.fw), cpu: [c[i], c[i + 1], c[i + 2], c[i + 3]], gpu: [g[i], g[i + 1], g[i + 2], g[i + 3]] };
    }
    if (!n) { rep.identical++; continue; }
    rep.tilesDiffering++;
    rep.texelsDiffering += n;
    if (rep.examples.length < 8 && first) rep.examples.push({ key: tiles[k].job.key, texels: n, first });
  }
  return rep;
}

/* -- in the game: the compose worker's boundaries, on the GPU ---------------- */

const GPU_KEY = "ml-gpu-compose";
/** His switch (Settings -> Dev "GPU transitions"), remembered; OFF by default. */
export function gpuComposeEnabled(): boolean {
  try {
    return localStorage.getItem(GPU_KEY) === "1";
  } catch {
    return false;
  }
}
export function setGpuComposeEnabled(on: boolean): void {
  try {
    localStorage.setItem(GPU_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: this session only */
  }
}

/** The new-shape work (ms, CPU) a frame's flush may start. */
const GPU_SHAPE_MS = 4;
/** Direct tiles remembered as waiting for an input (oldest dropped past it). */
const WAITING_MAX = 8192;

/** The slice of Phaser's WebGL renderer the compositor shares (3.90). */
export interface GpuHost {
  gl: WebGLRenderingContext;
  /** Flush and set aside the renderer's pipeline before raw GL, put it back after. */
  clear(): void;
  rebind(): void;
  /** A fw x fh texture of the renderer's own (uninitialised), and its GL handle. */
  newTexture(w: number, h: number): { wrapper: unknown; gl: WebGLTexture };
  /** Register a composed tile under its key (TextureManager.addGLTexture) and
   *  tell the factory it landed. */
  land(key: string, wrapper: unknown): void;
  /** Raw GL bound a texture behind the renderer's back: forget its cache. */
  dirty(): void;
  /** The ground pipeline (groundpipe.ts), given the direct store. */
  groundPipe(direct: GpuDirect | null): void;
}

/** THE COMPOSE WORKER'S STAND-IN FOR BOUNDARIES, ON THE GAME'S OWN GPU CONTEXT.
 *  Every boundary job the factory would post is composed here, a batch a frame
 *  (or all at once, `flushNow`, before a paint that must not owe), and each tile
 *  is COPIED ON THE GPU (copyTexSubImage2D) from the batch's output target into
 *  a texture of the renderer's own, registered under its key: no readback, no
 *  upload of the tile. What repeats is uploaded once (GpuBoundaries). Plates,
 *  fades and anything else still go to the worker. The plates a boundary needs
 *  are decoded and conformed here once per side (the worker's
 *  `buildPlatePixels`) and uploaded once; a job whose plates are not here yet
 *  waits for them. Any GL failure switches it off for the session and hands its
 *  queue back to the worker. */
export class GpuComposer {
  on = gpuComposeEnabled();
  private gpu: GpuBoundaries | null = null;
  private queue: BoundaryJob[] = [];
  private ramps: RampJob[] = [];
  private rampPending = new Set<string>();
  private gpuR: GpuRamps | null = null;
  /** THE DIRECT DRAW's resident store (made in `prepare`). */
  private direct: GpuDirect | null = null;
  private readyCb: (() => void) | null = null;
  private flushQueued = false;
  private plates = new Map<string, Pixels | Promise<Pixels>>();
  private src = new Map<string, Promise<Pixels>>();
  readonly stats = { queued: 0, composed: 0, ramps: 0, batches: 0, ms: 0, shapeMs: 0, fellBack: 0, waitingPlates: 0, prepAsked: 0, prepLanded: 0, prepMissed: 0, mainShapes: 0, sumsOut: 0, sumsOutPasses: 0, sumsOutMs: 0, landTiles: 0, uploads: { plates: 0, shapes: 0, frames: 0 }, error: "" };
  constructor(
    private inner: {
      ready(): boolean;
      compose(job: ComposeJob): void;
      /** The worker's prep (composeclient `prep`/`onPrep`); absent = done here. */
      prep?(reqs: GpuPrepReq[]): boolean;
      onPrep?(cb: (m: GpuPrepOut) => void): void;
    },
    private sheets: () => PatternSheets | null,
    private host: () => GpuHost | null,
    /** Every mask frame the patterns define (preloaded with the compositor). */
    private frames: () => number[] = () => [],
  ) {
    inner.onPrep?.((m) => this.onPrep(m));
  }
  /** Asked of the worker and not answered yet (plate ids, shape keys). */
  private asked = new Set<string>();
  private onPrep(m: GpuPrepOut): void {
    const sheets = this.sheets();
    if (!sheets) return;
    if (m.type === "gpuplate") this.plates.set(m.id, { w: m.w, h: m.h, data: new Uint8ClampedArray(m.data) });
    else if (m.type === "gpushape") putShape(sheets, m.key, new Uint8Array(m.data));
    else if (m.type === "gpurshape") putRampShape(sheets, m.key, m.h, new Uint8Array(m.map), new Float64Array(m.shades));
    else { this.stats.prepMissed++; this.stats.error = m.error.slice(0, 160); }
    if (m.type !== "gpumiss") { this.asked.delete(m.type === "gpuplate" ? m.id : m.key); this.stats.prepLanded++; this.landDue = true; }
    this.schedule();
    this.readyCb?.();
  }
  /** Ask the worker once; false = it cannot (not ready): do it here. */
  private ask(id: string, req: GpuPrepReq): boolean {
    if (this.asked.has(id)) return true;
    if (!this.inner.prep?.([req])) return false;
    this.asked.add(id);
    this.stats.prepAsked++;
    return true;
  }
  /** MADE AT LOAD, not at the first transition: the compositor, its standing
   *  resources and every mask/seam frame. Called by the scene once the pattern
   *  sheets are resident; harmless to call again. */
  prepare(): void {
    const sheets = this.sheets(), host = this.host();
    if (!this.on || this.gpu || !sheets || !host) return;
    host.clear();
    try {
      this.gpu = new GpuBoundaries(host.gl, sheets);
      this.gpu.shared.preloadFrames(sheets, this.frames());
      this.gpuR = new GpuRamps(host.gl, sheets, this.gpu.shared);
      const units = host.gl.getParameter(host.gl.MAX_TEXTURE_IMAGE_UNITS) as number;
      if (units >= 8) {
        this.direct = new GpuDirect(host.gl, sheets, this.gpu.shared, () => host.dirty());
        host.groundPipe(this.direct);
      } else this.stats.error = `direct draw: ${units} texture units`;
    } catch (e) {
      this.stats.error = String((e as Error)?.message ?? e);
      this.on = false;
    } finally {
      host.gl.bindFramebuffer(host.gl.FRAMEBUFFER, null);
      host.rebind();
    }
  }
  ready(): boolean {
    return this.inner.ready();
  }
  /** Called when prepared inputs land (a plate, a shape): cells the direct
   *  draw could not paint yet may be repainted. */
  onReady(cb: () => void): void {
    this.readyCb = cb;
  }
  /** DIRECT TILES WAITING FOR AN INPUT (a plate or a shape the worker is
   *  making), by key: made the frame their inputs land (`frameStart`), outside
   *  any paint — so the repaint that finally draws them (the owed retry, the
   *  drop drain) meets a tile whose outline colour is already computed. */
  private waiting = new Map<string, { b?: BoundaryJob; r?: RampJob }>();
  private landDue = false;
  get waitingCount(): number { return this.waiting.size; }
  private wait(key: string, w: { b?: BoundaryJob; r?: RampJob }): void {
    if (this.waiting.size >= WAITING_MAX && !this.waiting.has(key)) {
      const first = this.waiting.keys().next();
      if (!first.done) this.waiting.delete(first.value);
    }
    this.waiting.set(key, w);
  }
  /** THE FRAME'S START (the scene, before anything paints): the waiting tiles
   *  whose inputs have landed are made (at most `ms`; the rest go to the back
   *  of the line), then every outline colour made since the last pass is
   *  computed in one pass — never inside the ground's batch. */
  frameStart(ms = 2): void {
    if (!this.directStore) return;
    if (this.landDue && this.waiting.size) {
      this.landDue = false;
      const t0 = performance.now();
      for (const [key, w] of [...this.waiting]) {
        if (performance.now() - t0 > ms) { this.landDue = true; break; }
        this.waiting.delete(key);
        if (this.direct?.has(key)) continue; // a paint made it first
        if (w.b ? this.directBoundary(w.b) : this.directRamp(w.r!)) this.stats.landTiles++;
      }
    }
    this.sumsNow();
  }
  /** THE OUTLINE COLOURS OF EVERY TILE FIRST SEEN SINCE THE LAST CALL, in one
   *  GPU pass OUTSIDE any ground drawing — at the frame's start (`frameStart`)
   *  and before every ground bracket opens (the scene's `gpuPrewalk` has made
   *  the tiles that paint will draw). Inside a batch (groundpipe
   *  `onBeforeFlush`) is the fallback only: a pass there moves the GPU off the
   *  ground target and back in the middle of its paint. Answers how many tiles
   *  were done. */
  sumsNow(): number {
    const d = this.directStore, host = this.host();
    if (!d || !host || !d.pendingSums) return 0;
    const t0 = performance.now();
    host.clear();
    let n = 0;
    try {
      n = d.sumsPass();
    } finally {
      host.gl.bindFramebuffer(host.gl.FRAMEBUFFER, null);
      host.rebind();
      host.dirty();
    }
    this.stats.sumsOut += n;
    this.stats.sumsOutPasses++;
    this.stats.sumsOutMs += performance.now() - t0;
    return n;
  }
  /** The resident store, while the direct draw is on. */
  get directStore(): GpuDirect | null {
    return this.on ? this.direct : null;
  }
  /** THE FACTORY'S DIRECT HOOK for a transition: true = the ground pipeline can
   *  paint `job.key` now. Its plates are conformed and its shape made on the
   *  compose worker (asked once); until both are here, false. */
  directBoundary(job: BoundaryJob): boolean {
    noteJob(job);
    const d = this.directStore, sheets = this.sheets();
    if (!d || !sheets) return false;
    if (d.has(job.key)) return true;
    if (!supported(job)) return false;
    const a = this.plateOf(job.a, sheets), b = this.plateOf(job.b, sheets);
    if (!a || !b || (!gpuShapeReady(sheets, job) && this.ask(shapeKey(job), { kind: "bshape", key: shapeKey(job), job }))) {
      this.wait(job.key, { b: job });
      return false;
    }
    try {
      return !!d.boundary(job.key, job, a, b);
    } catch (e) {
      this.stats.error = String((e as Error)?.message ?? e).slice(0, 160);
      return false;
    }
  }
  /** ...and for a composed ramp or a lined flat top. */
  directRamp(job: RampJob): boolean {
    noteRampJob(job);
    const d = this.directStore, sheets = this.sheets();
    if (!d || !sheets) return false;
    if (d.has(job.key)) return true;
    const band = this.plateOf(job.band as BoundaryJob["a"], sheets);
    let t: RampTile | null = null;
    if (job.top.kind === "plate") {
      const top = this.plateOf(job.top.side as BoundaryJob["a"], sheets);
      if (band && top) t = { job, band, top };
    } else {
      const a = this.plateOf(job.top.job.a, sheets), bb = this.plateOf(job.top.job.b, sheets);
      if (band && a && bb) t = { job, band, a, b: bb };
    }
    const bj = job.top.kind === "boundary" ? job.top.job : null;
    const rk = rampJobShapeKey(job);
    if (!t || (!rampShapeReady(sheets, job) && this.ask(rk, { kind: "rshape", key: rk, job })) || (bj && !gpuShapeReady(sheets, bj) && this.ask(shapeKey(bj), { kind: "bshape", key: shapeKey(bj), job: bj }))) {
      this.wait(job.key, { r: job });
      return false;
    }
    try {
      return !!d.ramp(job.key, t);
    } catch (e) {
      this.stats.error = String((e as Error)?.message ?? e).slice(0, 160);
      return false;
    }
  }
  get pending(): number {
    return this.queue.length + this.ramps.length;
  }
  /** The factory's ramp hook (Tiles3TexturesOpts.gpuRamp): true = taken. */
  ramp(job: RampJob): boolean {
    noteRampJob(job); // the parity gate's sample, on or off
    if (!this.on || !this.sheets() || !this.host()) return false;
    if (this.rampPending.has(job.key)) return true;
    this.rampPending.add(job.key);
    this.ramps.push(job);
    this.stats.queued++;
    this.schedule();
    return true;
  }
  compose(job: ComposeJob): void {
    noteJob(job);
    if (!this.on || job.kind !== "boundary" || !supported(job) || !this.sheets() || !this.host()) {
      this.inner.compose(job);
      return;
    }
    this.queue.push(job);
    this.stats.queued++;
    this.schedule();
  }
  private schedule(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    requestAnimationFrame(() => {
      this.flushQueued = false;
      this.flush(1, GPU_SHAPE_MS);
      if (this.pending > this.stats.waitingPlates) this.schedule();
    });
  }
  private plateOf(s: BoundaryJob["a"], sheets: PatternSheets): Pixels | null {
    const id = `${sideId(s)}|${s.wall.join(",")}`;
    const hit = this.plates.get(id);
    if (hit && !(hit instanceof Promise)) return hit;
    // decoded and conformed on the WORKER (its own memo), never here while it can
    if (hit === undefined && this.ask(id, { kind: "plate", id, side: s as ComposeSide })) return null;
    if (hit === undefined) {
      let p = this.src.get(s.url);
      if (!p) {
        p = decodeUrl(s.url);
        this.src.set(s.url, p);
        p.catch(() => this.src.delete(s.url));
      }
      const built = p.then((px) => buildPlate(sheets, s, px));
      this.plates.set(id, built);
      built.then(
        (px) => { this.plates.set(id, px); this.schedule(); },
        () => this.plates.delete(id),
      );
    }
    return null;
  }
  /** Compose what is queued and ready: at most `batches` batches, starting at
   *  most `shapeMs` of new-shape work (a shape is CPU: the pipeline over
   *  coordinate plates). Answers how many tiles landed. */
  flushNow(batches = Infinity, shapeMs = Infinity): number {
    return this.flush(batches, shapeMs);
  }
  private flush(batches: number, shapeMs: number): number {
    const sheets = this.sheets(), host = this.host();
    if ((!this.queue.length && !this.ramps.length) || !sheets || !host) return 0;
    if (!this.on) { this.giveBack(); return 0; }
    let landed = 0;
    host.clear();
    try {
      if (!this.gpu) { this.gpu = new GpuBoundaries(host.gl, sheets); this.gpu.shared.preloadFrames(sheets, this.frames()); }
      const gl = host.gl, gpu = this.gpu, { fw, fh } = sheets;
      const s0 = performance.now();
      this.stats.waitingPlates = 0;
      for (let b = 0; b < batches && this.queue.length; b++) {
        const take: GpuTile[] = [], later: BoundaryJob[] = [];
        let waiting = 0;
        for (const j of this.queue) {
          if (take.length >= GpuBoundaries.BATCH) { later.push(j); continue; }
          const a = this.plateOf(j.a, sheets), bb = this.plateOf(j.b, sheets);
          if (!a || !bb) { later.push(j); waiting++; continue; }
          if (!gpuShapeReady(sheets, j)) {
            // the shape is the WORKER's to make; here only when it cannot, and within budget
            if (this.ask(shapeKey(j), { kind: "bshape", key: shapeKey(j), job: j }) || performance.now() - s0 > shapeMs) { later.push(j); waiting++; continue; }
            this.stats.mainShapes++;
          }
          shapeOf(sheets, j, a, bb);
          take.push({ a, b: bb, job: j });
        }
        this.stats.waitingPlates = waiting;
        this.queue = later;
        void 0;
        if (!take.length) break;
        const t0 = performance.now();
        const made: { key: string; wrapper: unknown }[] = [];
        gpu.compose(take, {
          kind: "copy",
          each: (k, x, y) => {
            const t = host.newTexture(fw, fh);
            gl.bindTexture(gl.TEXTURE_2D, t.gl);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x, y, fw, fh);
            made.push({ key: take[k].job.key, wrapper: t.wrapper });
          },
        }, true);
        this.stats.ms += performance.now() - t0;
        this.stats.batches++;
        for (const m of made) host.land(m.key, m.wrapper);
        landed += made.length;
        this.stats.composed += made.length;
      }
      // THE RAMPS, the same way: a batch of what is ready, copied GPU to GPU
      if (!this.gpuR) this.gpuR = new GpuRamps(gl, sheets, gpu.shared);
      const gr = this.gpuR;
      for (let b = 0; b < batches && this.ramps.length; b++) {
        const take: RampTile[] = [], later: RampJob[] = [];
        let waiting = 0;
        for (const j of this.ramps) {
          if (take.length >= GpuRamps.BATCH) { later.push(j); continue; }
          const band = this.plateOf(j.band as BoundaryJob["a"], sheets);
          let t: RampTile | null = null;
          if (j.top.kind === "plate") {
            const top = this.plateOf(j.top.side as BoundaryJob["a"], sheets);
            if (band && top) t = { job: j, band, top };
          } else {
            const a = this.plateOf(j.top.job.a, sheets), bb = this.plateOf(j.top.job.b, sheets);
            if (band && a && bb) t = { job: j, band, a, b: bb };
          }
          if (!t) { later.push(j); waiting++; continue; }
          const bj = j.top.kind === "boundary" ? j.top.job : null;
          const need = !rampShapeReady(sheets, j) || (bj && !gpuShapeReady(sheets, bj));
          if (need) {
            const rk = rampJobShapeKey(j);
            const asked = (rampShapeReady(sheets, j) || this.ask(rk, { kind: "rshape", key: rk, job: j })) && (!bj || gpuShapeReady(sheets, bj) || this.ask(shapeKey(bj), { kind: "bshape", key: shapeKey(bj), job: bj }));
            if (asked || performance.now() - s0 > shapeMs) { later.push(j); waiting++; continue; }
            this.stats.mainShapes++;
          }
          rampFullShape(sheets, t);
          take.push(t);
        }
        this.stats.waitingPlates += waiting;
        this.ramps = later;
        if (!take.length) break;
        const t0 = performance.now();
        const made: { key: string; wrapper: unknown }[] = [];
        gr.compose(take, {
          kind: "copy",
          each: (k, x, y) => {
            const h = gr.heightOf(take[k]);
            const t = host.newTexture(fw, h);
            gl.bindTexture(gl.TEXTURE_2D, t.gl);
            gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x, y, fw, h);
            made.push({ key: take[k].job.key, wrapper: t.wrapper });
          },
        }, true);
        this.stats.ms += performance.now() - t0;
        this.stats.batches++;
        for (const m of made) { this.rampPending.delete(m.key); host.land(m.key, m.wrapper); }
        landed += made.length;
        this.stats.composed += made.length;
        this.stats.ramps += made.length;
      }
      this.stats.shapeMs += performance.now() - s0;
      this.stats.uploads = gpu.uploads;
    } catch (e) {
      this.stats.error = String((e as Error)?.message ?? e);
      this.on = false;
      this.giveBack();
    } finally {
      host.gl.bindFramebuffer(host.gl.FRAMEBUFFER, null);
      host.rebind();
    }
    return landed;
  }
  private giveBack(): void {
    for (const j of this.queue.splice(0)) { this.stats.fellBack++; this.inner.compose(j); }
    // a ramp has no worker: its key is simply not built, and the factory builds
    // it here the next time a paint asks (the hook now answers false)
    this.ramps = [];
    this.rampPending.clear();
  }
}

function rampShapeReady(sheets: PatternSheets, j: RampJob): boolean {
  return !!rampFullMemo.get(sheets)?.has(rampJobShapeKey(j));
}
export const seenRampJobs = new Map<string, RampJob>();
function noteRampJob(j: RampJob): void {
  if (seenRampJobs.size >= 3000) seenRampJobs.delete(seenRampJobs.keys().next().value as string);
  seenRampJobs.set(j.key, j);
}

/** A shape made elsewhere (the compose worker), put where `shapeOf` finds it. */
export function putShape(sheets: PatternSheets, key: string, s: Shape): void {
  let m = shapeMemo.get(sheets);
  if (!m) shapeMemo.set(sheets, (m = new Map()));
  m.set(key, s);
}
/** A ramp shape made by the compose worker: its map as-is, its shades (values,
 *  -1 = none) turned into rows of THIS thread's table. */
export function putRampShape(sheets: PatternSheets, key: string, h: number, map: Uint8Array, shades: Float64Array): void {
  let m = rampFullMemo.get(sheets);
  if (!m) rampFullMemo.set(sheets, (m = new Map()));
  const fw = sheets.fw;
  const rows = new Uint8Array(fw * RAMP_H * 4);
  const row = new Int32Array(fw * h).fill(-1);
  for (let y = 0; y < RAMP_H; y++)
    for (let x = 0; x < fw; x++) {
      const i = y * fw + x;
      if (map[i * 4 + 3] || map[i * 4 + 2] % 4 === 3) rows[i * 4 + 3] = 255;
      const srb = shades[i * 2];
      if (srb < 0) continue;
      const r = shadeRow(srb, shades[i * 2 + 1]);
      rows[i * 4] = r & 255;
      rows[i * 4 + 1] = r >> 8;
      if (y < h) row[i] = r;
    }
  m.set(key, { map, rows, shape: { w: fw, h, map, row }, h });
}

/** Is this job's shape already made (no CPU work to compose it)? */
function gpuShapeReady(sheets: PatternSheets, j: BoundaryJob): boolean {
  return !!shapeMemo.get(sheets)?.has(shapeKey(j));
}

async function buildPlate(sheets: PatternSheets, s: BoundaryJob["a"], src: Pixels): Promise<Pixels> {
  if (s.kind === "raw") return src; // a ramp's band (and a clean ramp's top): the art itself
  return buildPlatePixels(sheets, { kind: s.kind, path: s.path, topOnly: s.topOnly, rise: s.rise }, src, s.wall);
}

/* -- COMPOSED RAMPS (tiles3draw `buildRampPixels`) ----------------------------
 * A ramp raster copies texels: the TOP's (the plate, or the transition the ramp
 * lifts), lifted onto the incline and SHADED by a factor of their own height
 * (`1 - 0.07·mid` red/blue, `1 - 0.03·mid` green), stretched and bridged by
 * repeating a texel, and the BAND's (the art's own) under the side faces. Its
 * shape — which texel each output texel copies, from which of the two, and its
 * alpha — is taken from `buildRampPixels` ITSELF: it runs over plates whose
 * texels carry their own coordinates as bits (0 or 7 per channel: the shade can
 * move a channel by at most 0.07·7 < 0.5, so a bit survives it), five runs for
 * the 13 bits of (x, y, which). The shade of a top texel is the CPU's formula at
 * its source texel; every distinct shade gets a row of the CPU's own rounding,
 * `Math.round(d·sh)` for d 0..255 (a table: float32 lands on the other side of
 * a .5 now and then), checked against a run over a white top. */

export interface RampShape {
  w: number;
  h: number;
  /** Per texel: source x, source y, which (0 nothing, 1 top, 2 band), alpha. */
  map: Uint8Array;
  /** Per texel: the GLOBAL shade row of a top texel (-1 none) — SHADE_ROWS. */
  row: Int32Array;
}

/** THE SHADE TABLE, ONE FOR THE WHOLE GAME. A shade depends only on the slope's
 *  direction and the source texel (never on the art, the ground or the rise):
 *  measured, all 256 directions over the top face's 29 rows make 533 distinct
 *  (red/blue, green) pairs. Each gets ONE row, appended the first time it is
 *  met and never moved (a per-shape table overflowed and rows were reused under
 *  ramps still reading them: 293 of 807 ramps shaded wrong). Row r holds the
 *  CPU's own `Math.round(d·sh)` for d 0..255. */
export const SHADE_ROWS: [number, number][] = [];
const shadeIndex = new Map<string, number>();
function shadeRow(srb: number, sg: number): number {
  const k = `${srb},${sg}`;
  let r = shadeIndex.get(k);
  if (r === undefined) { r = SHADE_ROWS.push([srb, sg]) - 1; shadeIndex.set(k, r); }
  return r;
}
/** The 256 texels (RGBA) of shade row `r`. */
export function shadeRowBytes(r: number): Uint8Array {
  const [srb, sg] = SHADE_ROWS[r];
  const out = new Uint8Array(256 * 4);
  for (let d = 0; d < 256; d++) { out[d * 4] = Math.round(d * srb); out[d * 4 + 1] = Math.round(d * sg); out[d * 4 + 3] = 255; }
  return out;
}

const rampMemo = new WeakMap<PatternSheets, Map<string, RampShape>>();

/** The shade `buildRampPixels` puts on the top texel it lifts from (x, y). */
function rampShade(mask: number, x: number, y: number): [number, number] {
  const a = (x + 0.5 - DX) / DX;
  const b = (y + 0.5) / DY;
  const u = (a + b) / 2, v = (b - a) / 2;
  const h = rampHeight(mask, u, v);
  const mid = 4 * h * (1 - h);
  return [1 - 0.07 * mid, 1 - 0.03 * mid];
}

export function rampShapeKey(mask: number, lh: number, topId: string, bandId: string, withBand: boolean): string {
  return `${mask}|${lh}|${withBand ? 1 : 0}|${topId}|${bandId}`;
}

/** The shape of `buildRampPixels(sheets, top, mask, lh, band, withBand)` for
 *  tops and bands with these alphas (the shape depends on alpha only). */
export function rampShapeOf(sheets: PatternSheets, mask: number, lh: number, top: Pixels, band: Pixels, withBand: boolean, key?: string): RampShape {
  let m = rampMemo.get(sheets);
  if (!m) rampMemo.set(sheets, (m = new Map()));
  const hit = key ? m.get(key) : undefined;
  if (hit) return hit;
  const { fw, fh } = sheets;
  const probe = (bits: (x: number, y: number, which: number) => [number, number, number], src: Pixels, which: number): Pixels => {
    const out = newPixels(src.w, src.h);
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        const i = (y * src.w + x) * 4;
        const [r, g, b] = bits(x, y, which);
        out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = src.data[i + 3];
      }
    return out;
  };
  // 13 bits: x (6), y (6), which (1) — three per run, as 0 / 7
  const field = (x: number, y: number, which: number) => x | (y << 6) | ((which - 1) << 12);
  const runs: Pixels[] = [];
  for (let r = 0; r < 5; r++) {
    const bit = (x: number, y: number, w: number): [number, number, number] => {
      const f = field(x, y, w);
      return [((f >> (3 * r)) & 1) * 7, ((f >> (3 * r + 1)) & 1) * 7, ((f >> (3 * r + 2)) & 1) * 7];
    };
    runs.push(buildRampPixels(sheets, probe(bit, top, 1), mask, lh, probe(bit, band, 2), withBand));
  }
  const white = buildRampPixels(sheets, probe(() => [255, 255, 255], top, 1), mask, lh, probe(() => [0, 0, 0], band, 2), withBand);
  const W = runs[0].w, H = runs[0].h;
  const map = new Uint8Array(W * H * 4);
  const row = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) {
    const a = runs[0].data[i * 4 + 3];
    if (a === 0) continue;
    let f = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (runs[r].data[i * 4 + c] >= 4) f |= 1 << (3 * r + c);
    const x = f & 63, y = (f >> 6) & 63, which = ((f >> 12) & 1) + 1;
    map[i * 4] = x; map[i * 4 + 1] = y; map[i * 4 + 2] = which; map[i * 4 + 3] = a;
    if (which === 1) {
      const [srb, sg] = rampShade(mask, x, y);
      // the CPU's own shade, read back off a white top: it must agree
      if (white.data[i * 4] !== Math.round(255 * srb) || white.data[i * 4 + 1] !== Math.round(255 * sg))
        throw new Error(`tiles3gpu: ramp shade at ${i % W},${Math.floor(i / W)} is not the formula's (${white.data[i * 4]} vs ${Math.round(255 * srb)})`);
      row[i] = shadeRow(srb, sg);
    }
  }
  const shape: RampShape = { w: W, h: H, map, row };
  if (key) m.set(key, shape);
  void fw; void fh;
  return shape;
}

/** THE RAMP FROM ITS SHAPE, on the CPU — exactly what the GPU pass computes
 *  (a lookup per texel): the node gate's half of the parity. */
export function rampFromShape(shape: RampShape, top: Pixels, band: Pixels): Pixels {
  const out = newPixels(shape.w, shape.h);
  const o = out.data;
  for (let i = 0; i < shape.w * shape.h; i++) {
    const which = shape.map[i * 4 + 2];
    if (!which) continue;
    const x = shape.map[i * 4], y = shape.map[i * 4 + 1];
    const src = which === 1 ? top : band;
    const s = (y * src.w + x) * 4;
    if (which === 1) {
      const [srb, sg] = SHADE_ROWS[shape.row[i]];
      o[i * 4] = Math.round(src.data[s] * srb);
      o[i * 4 + 1] = Math.round(src.data[s + 1] * sg);
      o[i * 4 + 2] = Math.round(src.data[s + 2] * srb);
    } else {
      o[i * 4] = src.data[s]; o[i * 4 + 1] = src.data[s + 1]; o[i * 4 + 2] = src.data[s + 2];
    }
    o[i * 4 + 3] = shape.map[i * 4 + 3];
  }
  return out;
}

/* -- ramps on the GPU ---------------------------------------------------------- */

/** A ramp tile's slot: 64x64 (the tallest ramp is 64x61). */
const RAMP_H = 64;

export interface RampTile {
  job: RampJob;
  band: Pixels;
  /** The plate a plate-topped ramp lifts. */
  top?: Pixels;
  /** The two plates a transition-topped ramp's transition composes. */
  a?: Pixels;
  b?: Pixels;
}

const rampFullMemo = new WeakMap<PatternSheets, Map<string, { map: Uint8Array; rows: Uint8Array; shape: RampShape; h: number }>>();
const plateIdOf = (s: ComposeSide) => `${sideId(s as BoundaryJob["a"])}|${s.wall.join(",")}`;

function rampTopId(j: RampJob): string {
  return j.top.kind === "plate" ? "p:" + plateIdOf(j.top.side) : "b:" + shapeKey(j.top.job) + "|" + plateIdOf(j.top.job.a) + "|" + plateIdOf(j.top.job.b);
}
export function rampJobShapeKey(j: RampJob): string {
  const e = j.edge ? `${j.edge.mask},${j.edge.verts},${j.edge.nb}` : "";
  return `${rampShapeKey(j.mask, j.lh, rampTopId(j), plateIdOf(j.band), false)}|${e}`;
}

/** The top raster's ALPHA (all a ramp's shape reads of it): the plate's, or the
 *  transition's (its shape's final alpha). */
function rampTopAlpha(sheets: PatternSheets, t: RampTile): Pixels {
  if (t.job.top.kind === "plate") return t.top!;
  const sh = shapeOf(sheets, t.job.top.job, t.a, t.b);
  const out = newPixels(sheets.fw, sheets.fh);
  for (let i = 0; i < sheets.fw * sheets.fh; i++) out.data[i * 4 + 3] = sh[i * 4 + 3];
  return out;
}

/** A ramp's full shape: the lift (rampShapeOf), then — for a lined variant —
 *  the outline over its alpha (edgeTopPixels over a grey probe), as the ink
 *  classes of the boundary shape: map texel = (src x, src y, class + 4·which,
 *  final alpha); rows texel = (shade row lo, hi). */
export function rampFullShape(sheets: PatternSheets, t: RampTile): { map: Uint8Array; rows: Uint8Array; shape: RampShape; h: number } {
  let m = rampFullMemo.get(sheets);
  if (!m) rampFullMemo.set(sheets, (m = new Map()));
  const key = rampJobShapeKey(t.job);
  const hit = m.get(key);
  if (hit) return hit;
  const j = t.job;
  // A LINED PLATE (`mask` -1, no rise): the plate itself, texel for texel — the
  // identity map on its alpha, every texel through the identity shade (1, 1)
  const shape = j.mask === LINED_PLATE ? identityShape(t.top!) : rampShapeOf(sheets, j.mask, j.lh, rampTopAlpha(sheets, t), t.band, false, rampShapeKey(j.mask, j.lh, rampTopId(j), plateIdOf(j.band), false));
  const W = shape.w, H = shape.h;
  const map = new Uint8Array(sheets.fw * RAMP_H * 4), rows = new Uint8Array(sheets.fw * RAMP_H * 4);
  let post: Pixels | null = null;
  const outer = Math.round(PROBE * (1 - EDGE_ALPHA) + PROBE * EDGE_SHADE * EDGE_ALPHA);
  const inner = Math.round(PROBE * (1 - EDGE_ALPHA_IN) + PROBE * EDGE_SHADE_IN * EDGE_ALPHA_IN);
  if (j.edge) {
    const grey = newPixels(W, H);
    for (let i = 0; i < W * H; i++) {
      const a = shape.map[i * 4 + 3];
      if (!a) continue;
      grey.data[i * 4] = grey.data[i * 4 + 1] = grey.data[i * 4 + 2] = PROBE;
      grey.data[i * 4 + 3] = a;
    }
    post = edgeTopPixels(sheets, grey, j.edge.mask, j.mask === LINED_PLATE ? undefined : { mask: j.mask, lh: j.lh }, j.edge.verts, j.edge.nb);
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = (y * sheets.fw + x) * 4;
      const a0 = shape.map[i * 4 + 3];
      if (!a0) continue;
      let cls = 0, a1 = a0;
      if (post) {
        a1 = post.data[i * 4 + 3];
        const v = post.data[i * 4];
        cls = a1 === 0 ? 3 : v === outer ? 1 : v === inner ? 2 : v === PROBE ? 0 : 255;
        if (cls === 255) throw new Error(`tiles3gpu: ramp outline texel ${x},${y} inked to ${v}, neither line`);
      }
      map[o] = shape.map[i * 4];
      map[o + 1] = shape.map[i * 4 + 1];
      map[o + 2] = cls + 4 * shape.map[i * 4 + 2];
      map[o + 3] = a1;
      const r = shape.row[i];
      if (r >= 0) { rows[o] = r & 255; rows[o + 1] = r >> 8; }
      rows[o + 3] = 255;
    }
  const out = { map, rows, shape, h: H };
  m.set(key, out);
  return out;
}

/** RA: the ramp composite — per texel its source (the top, lifted and shaded
 *  through its row of the CPU's rounding; or the band, raw), alpha from the map;
 *  a transition top is itself read through its boundary shape and composed. */
const FRAG_RA = COMMON + `
uniform sampler2D uMap; uniform vec2 uMapSize;
uniform sampler2D uRows; uniform vec2 uRowsSize;
uniform sampler2D uLut; uniform vec2 uLutSize;
uniform sampler2D uBShapes; uniform vec2 uBShapesSize;
// vA: top plate (xy) or plate A (xy) / plate B (zw); vB: map slot (xy), band plate (zw)
// vC: boundary shape slot (xy); vD: frame slot (xy); aux in vE: (topKind 0 plate 1 boundary, seam)
varying vec4 vE;
void main() {
  vec2 l = floor(vLocal);
  vec4 m = bytes(at(uMap, uMapSize, vB.xy + l));
  float cls = mod(m.z, 4.0), which = floor(m.z / 4.0);
  if (m.w == 0.0 && cls != 3.0) { gl_FragColor = vec4(0.0); return; }
  vec2 src = m.xy;
  if (which == 2.0) { gl_FragColor = vec4(bytes(at(uPlates, uPlatesSize, vB.zw + src)).rgb, m.w) / 255.0; return; }
  vec3 t;
  if (vE.x < 0.5) {
    t = bytes(at(uPlates, uPlatesSize, vA.xy + src)).rgb;
  } else {
    vec4 s = bytes(at(uBShapes, uBShapesSize, vC.xy + src));
    vec2 bs = s.xy;
    vec4 f = bytes(at(uFrames, uFramesSize, vD.xy + bs));
    vec4 p = f.x > 127.0 ? at(uPlates, uPlatesSize, vA.zw + bs) : at(uPlates, uPlatesSize, vA.xy + bs);
    t = bytes(p).rgb;
    if (vE.y > 0.5 && f.y > 127.0)
      t = vec3(b8(at(uTone, vec2(256.0, 1.0), vec2(t.r, 0.0)).r), b8(at(uTone, vec2(256.0, 1.0), vec2(t.g, 0.0)).r), b8(at(uTone, vec2(256.0, 1.0), vec2(t.b, 0.0)).r));
  }
  vec4 rw = bytes(at(uRows, uRowsSize, vB.xy + l));
  float row = rw.x + rw.y * 256.0 + vE.z;
  vec3 o = vec3(b8(at(uLut, uLutSize, vec2(t.r, row)).r), b8(at(uLut, uLutSize, vec2(t.g, row)).g), b8(at(uLut, uLutSize, vec2(t.b, row)).r));
  gl_FragColor = vec4(o, m.w) / 255.0;
}`;

const VERT_R = `
precision highp float;
attribute vec2 aPos; attribute vec2 aLocal;
attribute vec4 aA; attribute vec4 aB; attribute vec2 aC; attribute vec2 aD; attribute vec4 aE;
uniform vec2 uTarget;
varying vec2 vLocal; varying vec4 vA; varying vec4 vB; varying vec2 vC; varying vec2 vD; varying vec4 vE;
void main() {
  vLocal = aLocal; vA = aA; vB = aB; vC = aC; vD = aD; vE = aE;
  gl_Position = vec4(aPos / uTarget * 2.0 - 1.0, 0.0, 1.0);
}`;

/** THE RAMPS on the shared resources: map/rows/LUT slots uploaded once per
 *  shape, a 64-row slot per tile, the boundary passes' sums (B) and ink (C). */
export class GpuRamps {
  private gl: WebGLRenderingContext;
  private pA: WebGLProgram;
  private pB: WebGLProgram;
  private pC: WebGLProgram;
  private buf: WebGLBuffer;
  private fb: WebGLFramebuffer;
  private maps: SlotAtlas;
  private rows: SlotAtlas;
  private lut: WebGLTexture;
  /** SHADE_ROWS already on the GPU (the table only grows). */
  private lutRows = 0;
  private comp: WebGLTexture;
  private out: WebGLTexture;
  private sums: WebGLTexture;
  private verts: Float32Array;
  static readonly BATCH = 64;
  private readonly cols = 32;
  private static readonly LUT_ROWS = 1024; // 533 exist
  readonly stats = { tiles: 0, batches: 0, ms: 0 };
  constructor(gl: WebGLRenderingContext, private sheets: PatternSheets, readonly shared: GpuShared) {
    this.gl = gl;
    const { fw } = sheets;
    this.pA = compile(gl, VERT_R, FRAG_RA);
    this.pB = compile(gl, VERT, FRAG_B.replace("__FH__", String(RAMP_H)).replace("__FW__", String(fw)));
    this.pC = compile(gl, VERT, FRAG_C);
    this.buf = gl.createBuffer()!;
    this.fb = gl.createFramebuffer()!;
    this.maps = new SlotAtlas(gl, fw, RAMP_H);
    this.rows = new SlotAtlas(gl, fw, RAMP_H);
    this.lut = texture(gl, 256, GpuRamps.LUT_ROWS, null);
    const CW = this.cols * fw, CH = Math.ceil(GpuRamps.BATCH / this.cols) * RAMP_H;
    this.comp = texture(gl, CW, CH, null);
    this.out = texture(gl, CW, CH, null);
    this.sums = texture(gl, GpuRamps.BATCH * 3, 1, null);
    this.verts = new Float32Array(GpuRamps.BATCH * 6 * 20);
  }
  get uploads(): { maps: number; lutRows: number } { // eslint-disable-line
    return { maps: this.maps.uploads, lutRows: this.lutRows };
  }
  /** The shade rows met since the last batch, uploaded (each once, ever). */
  private syncLut(): void {
    if (this.lutRows >= SHADE_ROWS.length) return;
    if (SHADE_ROWS.length > GpuRamps.LUT_ROWS) throw new Error(`tiles3gpu: ${SHADE_ROWS.length} shade rows, the table holds ${GpuRamps.LUT_ROWS}`);
    const gl = this.gl, n = SHADE_ROWS.length - this.lutRows;
    const data = new Uint8Array(n * 256 * 4);
    for (let r = 0; r < n; r++) data.set(shadeRowBytes(this.lutRows + r), r * 256 * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.lutRows, 256, n, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.lutRows = SHADE_ROWS.length;
  }
  compose(tiles: RampTile[], sink: GpuSink = { kind: "read" }, premultiply = false): Pixels[] {
    const gl = this.gl, { fw, fh } = this.sheets, sh = this.shared;
    const N = tiles.length;
    if (!N) return [];
    if (N > GpuRamps.BATCH) throw new Error(`tiles3gpu: a ramp batch holds ${GpuRamps.BATCH}`);
    const t0 = performance.now();
    const cols = this.cols;
    const per = tiles.map((t) => {
      const j = t.job;
      const full = rampFullShape(this.sheets, t);
      const sk = rampJobShapeKey(j);
      const pm = this.maps.origin(sk, () => full.map);
      const pr = this.rows.origin(sk, () => full.rows);
      const pband = sh.plate(plateIdOf(j.band), () => t.band);
      let pa = [0, 0], pb = [0, 0], pbs = [0, 0], pf = [0, 0], kind = 0, seam = 0;
      if (j.top.kind === "plate") pa = sh.plate(plateIdOf(j.top.side), () => t.top!);
      else {
        const bj = j.top.job;
        kind = 1;
        seam = bj.seam ? 1 : 0;
        pa = sh.plate(plateIdOf(bj.a), () => t.a!);
        pb = sh.plate(plateIdOf(bj.b), () => t.b!);
        pbs = sh.shapes.origin(shapeKey(bj), () => shapeOf(this.sheets, bj, t.a, t.b));
        pf = sh.frames.origin(String(bj.frame), () => frameTile(this.sheets, bj.frame));
      }
      return { pm, pr, lb: 0, pband, pa, pb, pbs, pf, kind, seam, h: full.h };
    });
    this.syncLut();
    const CW = cols * fw, CH = Math.ceil(GpuRamps.BATCH / cols) * RAMP_H;
    const org = (k: number) => [(k % cols) * fw, Math.floor(k / cols) * RAMP_H];
    // RA — its own vertex layout (20 floats)
    {
      const v = this.verts;
      let o = 0;
      for (let k = 0; k < N; k++) {
        const p = per[k];
        const [x0, y0] = org(k);
        const row = [0, 0, 0, 0, p.pa[0], p.pa[1], p.pb[0], p.pb[1], p.pm[0], p.pm[1], p.pband[0], p.pband[1], p.pbs[0], p.pbs[1], p.pf[0], p.pf[1], p.kind, p.seam, p.lb, 0];
        const corner = (x: number, y: number, lx: number, ly: number) => { row[0] = x; row[1] = y; row[2] = lx; row[3] = ly; v.set(row, o); o += 20; };
        const x1 = x0 + fw, y1 = y0 + RAMP_H;
        corner(x0, y0, 0, 0); corner(x1, y0, fw, 0); corner(x0, y1, 0, RAMP_H);
        corner(x1, y0, fw, 0); corner(x1, y1, fw, RAMP_H); corner(x0, y1, 0, RAMP_H);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.comp, 0);
      gl.viewport(0, 0, CW, CH);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
      gl.colorMask(true, true, true, true);
      gl.useProgram(this.pA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, o), gl.STREAM_DRAW);
      const names: [string, number, number][] = [["aPos", 2, 0], ["aLocal", 2, 2], ["aA", 4, 4], ["aB", 4, 8], ["aC", 2, 12], ["aD", 2, 14], ["aE", 4, 16]];
      for (const [n, size, off] of names) { const loc = gl.getAttribLocation(this.pA, n); if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 80, off * 4); } }
      gl.uniform2f(gl.getUniformLocation(this.pA, "uTarget"), CW, CH);
      const tex = (name: string, unit: number, t: WebGLTexture, w: number, h: number) => {
        const loc = gl.getUniformLocation(this.pA, name);
        if (!loc) return;
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, unit);
        const sz = gl.getUniformLocation(this.pA, name + "Size");
        if (sz) gl.uniform2f(sz, w, h);
      };
      tex("uPlates", 0, sh.plates.tex, sh.plates.w, sh.plates.h);
      tex("uFrames", 2, sh.frames.tex, sh.frames.w, sh.frames.h);
      tex("uTone", 3, sh.tone, 256, 1);
      tex("uMap", 4, this.maps.tex, this.maps.w, this.maps.h);
      tex("uRows", 5, this.rows.tex, this.rows.w, this.rows.h);
      tex("uLut", 6, this.lut, 256, GpuRamps.LUT_ROWS);
      tex("uBShapes", 7, sh.shapes.tex, sh.shapes.w, sh.shapes.h);
      gl.drawArrays(gl.TRIANGLES, 0, o / 20);
      for (const [n] of names) { const loc = gl.getAttribLocation(this.pA, n); if (loc >= 0) gl.disableVertexAttribArray(loc); }
    }
    // B and C with the boundary layout (16 floats): the map atlas is C's "shapes"
    const v = this.verts;
    const quads = (rect: (k: number) => [number, number, number, number], lw: number, lh2: number, fix: (k: number, row: number[]) => void) => {
      let o = 0;
      for (let k = 0; k < N; k++) {
        const [x0, y0, x1, y1] = rect(k);
        const p = per[k];
        const [cx, cy] = org(k);
        const row = [0, 0, 0, 0, 0, 0, 0, 0, p.pm[0], p.pm[1], 0, 0, cx, cy, 0, 0];
        fix(k, row);
        const corner = (x: number, y: number, lx: number, ly: number) => { row[0] = x; row[1] = y; row[2] = lx; row[3] = ly; v.set(row, o); o += 16; };
        corner(x0, y0, 0, 0); corner(x1, y0, lw, 0); corner(x0, y1, 0, lh2);
        corner(x1, y0, lw, 0); corner(x1, y1, lw, lh2); corner(x0, y1, 0, lh2);
      }
      return o;
    };
    const run = (prog: WebGLProgram, target: WebGLTexture, tw: number, th: number, count: number, bind: () => void) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
      gl.viewport(0, 0, tw, th);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, count), gl.STREAM_DRAW);
      const names: [string, number, number][] = [["aPos", 2, 0], ["aLocal", 2, 2], ["aA", 4, 4], ["aB", 4, 8], ["aC", 2, 12], ["aD", 2, 14]];
      for (const [n, size, off] of names) { const loc = gl.getAttribLocation(prog, n); if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 64, off * 4); } }
      gl.uniform2f(gl.getUniformLocation(prog, "uTarget"), tw, th);
      const tex = (name: string, unit: number, t: WebGLTexture, w: number, h: number) => {
        const loc = gl.getUniformLocation(prog, name);
        if (!loc) return;
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc, unit);
        const sz = gl.getUniformLocation(prog, name + "Size");
        if (sz) gl.uniform2f(sz, w, h);
      };
      tex("uShapes", 1, this.maps.tex, this.maps.w, this.maps.h);
      tex("uComp", 4, this.comp, CW, CH);
      tex("uSums", 5, this.sums, GpuRamps.BATCH * 3, 1);
      bind();
      gl.drawArrays(gl.TRIANGLES, 0, count / 16);
      for (const [n] of names) { const loc = gl.getAttribLocation(prog, n); if (loc >= 0) gl.disableVertexAttribArray(loc); }
    };
    const tileRect = (k: number): [number, number, number, number] => { const [x, y] = org(k); return [x, y, x + fw, y + RAMP_H]; };
    let n = quads((k) => [3 * k, 0, 3 * k + 3, 1], 3, 1, () => {});
    run(this.pB, this.sums, GpuRamps.BATCH * 3, 1, n, () => {});
    n = quads(tileRect, fw, RAMP_H, (k, row) => { row[4] = 3 * k; });
    run(this.pC, this.out, CW, CH, n, () => {
      gl.uniform4f(gl.getUniformLocation(this.pC, "uInk"), 2, 5, 21, 0);
      gl.uniform4f(gl.getUniformLocation(this.pC, "uInk2"), 11, 20, 27, 0);
      gl.uniform1f(gl.getUniformLocation(this.pC, "uPma"), premultiply ? 1 : 0);
    });
    const res: Pixels[] = [];
    if (sink.kind === "read") {
      const raw = new Uint8Array(CW * CH * 4);
      gl.readPixels(0, 0, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      for (let k = 0; k < N; k++) {
        const [ox, oy] = org(k);
        const H = per[k].h;
        const px = newPixels(fw, H);
        for (let y = 0; y < H; y++) px.data.set(raw.subarray(((oy + y) * CW + ox) * 4, ((oy + y) * CW + ox + fw) * 4), y * fw * 4);
        res.push(px);
      }
    } else {
      for (let k = 0; k < N; k++) { const [ox, oy] = org(k); sink.each(k, ox, oy); }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stats.tiles += N;
    this.stats.batches++;
    this.stats.ms += performance.now() - t0;
    void fh;
    return res;
  }
  /** The composed tile's height (the texture it is copied into). */
  heightOf(t: RampTile): number {
    return rampFullShape(this.sheets, t).h;
  }
}

/** A RampJob's `mask` for a LINED PLATE (tiles3draw `edgedTop` on a flat top):
 *  no lift, the plate with its outline. */
export const LINED_PLATE = -1;
function identityShape(top: Pixels): RampShape {
  const map = new Uint8Array(top.w * top.h * 4), row = new Int32Array(top.w * top.h).fill(-1);
  const r = shadeRow(1, 1);
  for (let y = 0; y < top.h; y++)
    for (let x = 0; x < top.w; x++) {
      const i = y * top.w + x, a = top.data[i * 4 + 3];
      if (!a) continue;
      map[i * 4] = x; map[i * 4 + 1] = y; map[i * 4 + 2] = 1; map[i * 4 + 3] = a;
      row[i] = r;
    }
  return { w: top.w, h: top.h, map, row };
}

/** The CPU's own raster for a ramp job (the parity gate's reference): `rampRaster`
 *  then, for a lined variant, `edgeTopPixels` — from the same decoded inputs. */
export function rampCpu(sheets: PatternSheets, t: RampTile): Pixels {
  const j = t.job;
  const top = j.top.kind === "plate" ? t.top! : buildBoundaryPixels(sheets, { maskFrame: j.top.job.frame, topOnly: j.top.job.topOnly, noWall: j.top.job.noWall, slope: j.top.job.slope }, t.a!, t.b!, j.top.job.seam);
  if (j.mask === LINED_PLATE) return j.edge ? edgeTopPixels(sheets, top, j.edge.mask, undefined, j.edge.verts, j.edge.nb) : top;
  const base = buildRampPixels(sheets, top, j.mask, j.lh, t.band, false);
  return j.edge ? edgeTopPixels(sheets, base, j.edge.mask, { mask: j.mask, lh: j.lh }, j.edge.verts, j.edge.nb) : base;
}

/* -- THE DIRECT DRAW (maintainer 2026-09-26: "The shader should use the already
 * uploaded base tile set and mask to render any transition tile anywhere! Just
 * tell it what and where and it can render them all in a single call!") ------
 *
 * No tile is made. The ground pipeline (groundpipe.ts) draws a transition, a
 * composed ramp or an outlined flat top as ONE QUAD IN THE GROUND'S OWN BATCH,
 * in painter order between the plain plates, and its fragment shader computes
 * each texel from what stays resident on the GPU: the plates, the boundary
 * shapes, the mask/seam frames, the ramp maps and shade rows, the seam tone and
 * each tile's colour sums. The quad's vertices carry WHAT (slot origins, mode,
 * seam, lift) and the batch carries WHERE; nothing else goes up per frame.
 *
 * THE SUMS (the outline inks in the tile's mean colour) are the one thing
 * computed per tile, ONCE, on the GPU: a new tile's three sum texels are drawn
 * into the resident sums texture by `sumsPass` right before the batch that
 * first draws it (groundpipe `onBeforeFlush`), from the same resident inputs.
 *
 * The functions below are the same arithmetic as passes A, B and C and FRAG_RA
 * (proven byte-exact against the CPU by `gpuParity`), rewritten to read their
 * inputs from four per-quad vectors instead of per-pass attributes. */

/** Sums slots: 3 texels each, SUMS_COLS a row. */
const SUMS_COLS = 512;
const SUMS_ROWS = 64;
/** The shade-row table's last row is the seam tone (rint(v·tone)). */
const LUT_ROWS = 1024;
const TONE_ROW = LUT_ROWS - 1;

/** One tile the direct draw can paint: `g` is its 16 per-quad floats.
 *  Boundary (mode 1): g0 plate A xy, plate B xy | g1 shape xy, frame xy |
 *    g2 mode, sums slot, seam, lift | g3 shifted side, 0, 0, 0.
 *  Ramp (mode 2) or lined flat top (mode 3, the cheap path):
 *    g0 top (or plate A) xy, plate B xy |
 *    g1 map xy (the rows share its slot), band xy | g2 mode, sums slot, seam,
 *    top kind (0 plate, 1 transition) | g3 boundary shape xy, frame xy. */
export interface DirectInst {
  g: Float32Array;
  w: number;
  h: number;
}

const DIRECT_COMMON = `
uniform sampler2D uPlates; uniform vec2 uPlatesSize;
uniform sampler2D uShapes; uniform vec2 uShapesSize;
uniform sampler2D uFrames; uniform vec2 uFramesSize;
uniform sampler2D uMaps; uniform vec2 uMapsSize;
uniform sampler2D uRows; uniform vec2 uRowsSize;
uniform sampler2D uLut; uniform vec2 uLutSize;
uniform sampler2D uSums; uniform vec2 uSumsSize;
uniform float uFH;
varying highp vec4 vG0;
varying highp vec4 vG1;
varying highp vec4 vG2;
varying highp vec4 vG3;
vec4 at(sampler2D t, vec2 size, vec2 px) { return texture2D(t, (px + 0.5) / size); }
float b8(float v) { return floor(v * 255.0 + 0.5); }
vec4 bytes(vec4 v) { return floor(v * 255.0 + 0.5); }
vec3 tone3(vec3 c) {
  return vec3(b8(at(uLut, uLutSize, vec2(c.r, ${TONE_ROW}.0)).r),
              b8(at(uLut, uLutSize, vec2(c.g, ${TONE_ROW}.0)).r),
              b8(at(uLut, uLutSize, vec2(c.b, ${TONE_ROW}.0)).r));
}
// pass A: the composite at local texel l, as bytes; cls = the outline class
vec4 compB(vec2 l, out float cls) {
  vec4 s = bytes(at(uShapes, uShapesSize, vG1.xy + l));
  cls = mod(s.z, 4.0);
  float side = floor(s.z / 4.0);
  if (s.w == 0.0 && cls != 3.0) return vec4(0.0);
  vec2 src = s.xy;
  bool useB;
  vec4 f;
  if (side == 0.0) {
    f = bytes(at(uFrames, uFramesSize, vG1.zw + src));
    useB = f.x > 127.0;
  } else {
    useB = side == 2.0;
    float row = side == vG3.x ? src.y : clamp(src.y - vG2.w, 0.0, uFH - 1.0);
    f = bytes(at(uFrames, uFramesSize, vG1.zw + vec2(src.x, row)));
  }
  vec3 rgb = bytes(useB ? at(uPlates, uPlatesSize, vG0.zw + src) : at(uPlates, uPlatesSize, vG0.xy + src)).rgb;
  if (vG2.z > 0.5 && f.y > 127.0) rgb = tone3(rgb);
  return vec4(rgb, s.w);
}
// FRAG_RA: a ramp (or a lined flat top) at local texel l
vec4 compR(vec2 l, out float cls) {
  vec4 m = bytes(at(uMaps, uMapsSize, vG1.xy + l));
  cls = mod(m.z, 4.0);
  float which = floor(m.z / 4.0);
  if (m.w == 0.0 && cls != 3.0) return vec4(0.0);
  vec2 src = m.xy;
  if (which == 2.0) return vec4(bytes(at(uPlates, uPlatesSize, vG1.zw + src)).rgb, m.w);
  vec3 t;
  if (vG2.w < 0.5) {
    t = bytes(at(uPlates, uPlatesSize, vG0.xy + src)).rgb;
  } else {
    vec2 bs = bytes(at(uShapes, uShapesSize, vG3.xy + src)).xy;
    vec4 f = bytes(at(uFrames, uFramesSize, vG3.zw + bs));
    t = bytes(f.x > 127.0 ? at(uPlates, uPlatesSize, vG0.zw + bs) : at(uPlates, uPlatesSize, vG0.xy + bs)).rgb;
    if (vG2.z > 0.5 && f.y > 127.0) t = tone3(t);
  }
  vec4 rw = bytes(at(uRows, uRowsSize, vG1.xy + l));
  float row = rw.x + rw.y * 256.0;
  return vec4(b8(at(uLut, uLutSize, vec2(t.r, row)).r), b8(at(uLut, uLutSize, vec2(t.g, row)).g), b8(at(uLut, uLutSize, vec2(t.b, row)).r), m.w);
}
// A LINED FLAT TOP (mode 3): the plate texel for texel under its outline —
// the map read for the outline class and alpha, the plate, nothing else (its
// shade row is the identity, rint(v * 1) = v: compR's rows and three table
// reads for the same bytes)
vec4 compL(vec2 l, out float cls) {
  vec4 m = bytes(at(uMaps, uMapsSize, vG1.xy + l));
  cls = mod(m.z, 4.0);
  if (m.w == 0.0 && cls != 3.0) return vec4(0.0);
  return vec4(bytes(at(uPlates, uPlatesSize, vG0.xy + m.xy)).rgb, m.w);
}
vec4 comp(vec2 l, out float cls) {
  if (vG2.x < 1.5) return compB(l, cls);
  if (vG2.x > 2.5) return compL(l, cls);
  return compR(l, cls);
}
`;

/** The ground pipeline's fragment shader: Phaser's Single shader for a plain
 *  quad (mode 0, unchanged), the direct tile for mode 1/2 — composite, then
 *  pass C's exact integer ink, then Phaser's upload premultiply, then the same
 *  tint multiply a plain quad gets. */
export const GROUND_FRAG = `#define SHADER_NAME ML_GROUND_FS
precision highp float;
uniform sampler2D uMainSampler;
varying vec2 outTexCoord;
varying float outTintEffect;
varying vec4 outTint;
${DIRECT_COMMON}
vec4 pma(vec4 c) {
  if (c.w == 0.0) return vec4(0.0);
  if (c.w == 255.0) return c;
  return vec4(floor((c.rgb * c.w + 127.5) / 255.0), c.w);
}
float ink(float d, float S, float n, vec4 k) {
  float dn = d * k.x;
  float q1 = floor(dn / k.y);
  float r1 = dn - q1 * k.y;
  if (r1 < 0.0) { q1 -= 1.0; r1 += k.y; }
  if (r1 >= k.y) { q1 += 1.0; r1 -= k.y; }
  float num = S * k.z;
  float den = 100.0 * n;
  float q2 = floor(num / den);
  float r2 = num - q2 * den;
  if (r2 < 0.0) { q2 -= 1.0; r2 += den; }
  if (r2 >= den) { q2 += 1.0; r2 -= den; }
  float lhs = 2.0 * (r1 * den + r2 * k.y);
  float rhs = k.y * den;
  float whole = lhs >= 2.0 * rhs ? 1.0 : 0.0;
  float rest = lhs - whole * 2.0 * rhs;
  return q1 + q2 + whole + (rest >= rhs ? 1.0 : 0.0);
}
float sum24(vec4 t) { return t.x + t.y * 256.0 + t.z * 65536.0; }
void main() {
  vec4 texel = vec4(outTint.bgr * outTint.a, outTint.a);
  if (vG2.x < 0.5) {
    vec4 texture = texture2D(uMainSampler, outTexCoord);
    vec4 color = texture * texel;
    if (outTintEffect == 1.0) color.rgb = mix(texture.rgb, outTint.bgr * outTint.a, texture.a);
    else if (outTintEffect == 2.0) color = texel;
    gl_FragColor = color;
    return;
  }
  float cls;
  vec4 c = comp(floor(outTexCoord), cls);
  if (cls == 1.0 || cls == 2.0) {
    float k = vG2.y;
    vec2 si = vec2(mod(k, ${SUMS_COLS}.0) * 3.0, floor(k / ${SUMS_COLS}.0));
    vec4 t0 = bytes(at(uSums, uSumsSize, si));
    vec4 t1 = bytes(at(uSums, uSumsSize, si + vec2(1.0, 0.0)));
    vec4 t2 = bytes(at(uSums, uSumsSize, si + vec2(2.0, 0.0)));
    float n = t0.w + t1.w * 256.0 + t2.w * 65536.0;
    // outer: 0.4 d = 2/5 d, 0.21 S/n ; inner: 0.55 d = 11/20 d, 0.27 S/n
    vec4 kk = cls == 1.0 ? vec4(2.0, 5.0, 21.0, 0.0) : vec4(11.0, 20.0, 27.0, 0.0);
    if (n > 0.0) c.rgb = vec3(ink(c.r, sum24(t0), n, kk), ink(c.g, sum24(t1), n, kk), ink(c.b, sum24(t2), n, kk));
  }
  gl_FragColor = (pma(c) / 255.0) * texel;
}`;

/** Phaser's Single vertex shader plus the four per-quad vectors. */
export const GROUND_VERT = `#define SHADER_NAME ML_GROUND_VS
precision highp float;
uniform mat4 uProjectionMatrix;
uniform vec2 uResolution;
attribute vec2 inPosition;
attribute vec2 inTexCoord;
attribute float inTexId;
attribute float inTintEffect;
attribute vec4 inTint;
attribute highp vec4 inG0;
attribute highp vec4 inG1;
attribute highp vec4 inG2;
attribute highp vec4 inG3;
varying vec2 outTexCoord;
varying float outTintEffect;
varying vec4 outTint;
varying highp vec4 vG0;
varying highp vec4 vG1;
varying highp vec4 vG2;
varying highp vec4 vG3;
void main() {
  gl_Position = uProjectionMatrix * vec4(inPosition, 1.0, 1.0);
  outTexCoord = inTexCoord;
  outTint = inTint;
  outTintEffect = inTintEffect;
  vG0 = inG0; vG1 = inG1; vG2 = inG2; vG3 = inG3;
}`;

/** pass B for the direct tiles: three sum texels per new tile, from the same
 *  composite the ground shader draws. */
const SUMS_VERT = `
precision highp float;
attribute vec2 aPos; attribute vec2 aLocal;
attribute vec4 aG0; attribute vec4 aG1; attribute vec4 aG2; attribute vec4 aG3;
uniform vec2 uTarget;
varying vec2 vLocal;
varying highp vec4 vG0; varying highp vec4 vG1; varying highp vec4 vG2; varying highp vec4 vG3;
void main() {
  vLocal = aLocal; vG0 = aG0; vG1 = aG1; vG2 = aG2; vG3 = aG3;
  gl_Position = vec4(aPos / uTarget * 2.0 - 1.0, 0.0, 1.0);
}`;
const SUMS_FRAG = (fw: number) => `
precision highp float;
varying vec2 vLocal;
${DIRECT_COMMON}
void main() {
  float part = floor(vLocal.x);
  float sr = 0.0, sg = 0.0, sb = 0.0, n = 0.0, cls;
  bool ramp = vG2.x > 1.5;
  for (int y = 0; y < ${RAMP_H}; y++) {
    if (!ramp && float(y) >= uFH) break;
    for (int x = 0; x < ${fw}; x++) {
      vec4 c = comp(vec2(float(x), float(y)), cls);
      if (c.w > 0.0) { sr += c.r; sg += c.g; sb += c.b; n += 1.0; }
    }
  }
  float v = part < 0.5 ? sr : (part < 1.5 ? sg : sb);
  float nb = part < 0.5 ? mod(n, 256.0) : (part < 1.5 ? mod(floor(n / 256.0), 256.0) : floor(n / 65536.0));
  gl_FragColor = vec4(mod(v, 256.0), mod(floor(v / 256.0), 256.0), floor(v / 65536.0), nb) / 255.0;
}`;

/** FNV-1a over a ramp map and its rows: identical maps share one slot (a lined
 *  flat top's map is its outline over the silhouette, whatever the plate). */
function hashBytes(a: Uint8Array, b: Uint8Array): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < a.length; i++) { h1 = Math.imul(h1 ^ a[i], 16777619); h2 = Math.imul(h2 ^ a[i], 2246822519); }
  for (let i = 0; i < b.length; i++) { h1 = Math.imul(h1 ^ b[i], 16777619); h2 = Math.imul(h2 ^ b[i], 2246822519); }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
}

/** Everything the direct draw reads, resident: the shared plates/shapes/frames,
 *  the ramp maps and rows (a slot per distinct map), the shade table with the
 *  seam tone in its last row, the sums. `unit` binds them for a batch.
 *  Uploads (a first-seen plate, shape, map, a new shade row) happen on
 *  texture unit 7 and put unit 0 back active; `dirty` tells the renderer. */
export class GpuDirect {
  readonly maps: SlotAtlas;
  readonly rows: SlotAtlas;
  readonly lut: WebGLTexture;
  readonly sums: WebGLTexture;
  private lutRows = 0;
  private insts = new Map<string, DirectInst>();
  private mapSlot = new Map<string, string>();
  private nextSum = 0;
  private pending: DirectInst[] = [];
  /** Sums slots by the tile's CONTENT (its 16 floats but the slot): two keys
   *  that paint the same tile share one slot and one sums computation. */
  private sumsBySig = new Map<string, number>();
  /** Give `g` its sums slot: the existing one for the same tile, else a new
   *  one queued for the sums pass. False = the sums texture is full. */
  private sumsFor(g: Float32Array, inst: DirectInst): boolean {
    g[9] = 0;
    const sig = Array.prototype.join.call(g, ",");
    const hit = this.sumsBySig.get(sig);
    if (hit !== undefined) { g[9] = hit; return true; }
    const s = this.sumSlot();
    if (s === null) return false;
    g[9] = s;
    this.sumsBySig.set(sig, s);
    this.pending.push(inst);
    return true;
  }
  private prog: WebGLProgram;
  private buf: WebGLBuffer;
  private fb: WebGLFramebuffer;
  readonly stats = { boundaries: 0, ramps: 0, sumsPasses: 0, sumsTiles: 0, full: 0, uploads: 0 };
  constructor(private gl: WebGLRenderingContext, private sheets: PatternSheets, readonly shared: GpuShared, private dirty: () => void) {
    const { fw, tone } = sheets;
    this.maps = new SlotAtlas(gl, fw, RAMP_H);
    this.rows = new SlotAtlas(gl, fw, RAMP_H);
    this.lut = texture(gl, 256, LUT_ROWS, null);
    const t = new Uint8Array(256 * 4);
    for (let v = 0; v < 256; v++) { t[v * 4] = rint(v * tone); t[v * 4 + 3] = 255; }
    this.upload(this.lut, 0, TONE_ROW, 256, 1, t);
    this.sums = texture(gl, SUMS_COLS * 3, SUMS_ROWS, null);
    this.prog = compile(gl, SUMS_VERT, SUMS_FRAG(fw));
    this.buf = gl.createBuffer()!;
    this.fb = gl.createFramebuffer()!;
    this.dirty();
  }
  get size(): number { return this.insts.size; }
  get(key: string): DirectInst | undefined { return this.insts.get(key); }
  has(key: string): boolean { return this.insts.has(key); }
  /** Run `f` (texture uploads) on unit 7, unit 0 active after. */
  private onUnit7<T>(f: () => T): T {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE7);
    try { return f(); } finally { gl.activeTexture(gl.TEXTURE0); this.dirty(); }
  }
  private upload(t: WebGLTexture, x: number, y: number, w: number, h: number, data: Uint8Array): void {
    this.onUnit7(() => {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    });
    this.stats.uploads++;
  }
  private slot(a: SlotAtlas, key: string, data: () => Uint8Array): [number, number] | null {
    if (a.has(key)) return a.tryOrigin(key, data);
    const n0 = a.uploads;
    const o = this.onUnit7(() => a.tryOrigin(key, data));
    if (a.uploads > n0) this.stats.uploads++;
    if (!o) this.stats.full++;
    return o;
  }
  private sumSlot(): number | null {
    if (this.nextSum >= SUMS_COLS * SUMS_ROWS) { this.stats.full++; return null; }
    return this.nextSum++;
  }
  private plate(id: string, px: Pixels): [number, number] | null {
    return this.slot(this.shared.plates, id, () => padTo(px, this.shared.plates));
  }
  /** A transition under `key`: its plates, shape and frame resident. */
  boundary(key: string, j: BoundaryJob, a: Pixels, b: Pixels): DirectInst | null {
    const hit = this.insts.get(key);
    if (hit) return hit;
    const pa = this.plate(plateIdOf(j.a), a), pb = this.plate(plateIdOf(j.b), b);
    const ps = this.slot(this.shared.shapes, shapeKey(j), () => shapeOf(this.sheets, j, a, b));
    const pf = this.slot(this.shared.frames, String(j.frame), () => frameTile(this.sheets, j.frame));
    if (!pa || !pb || !ps || !pf) return null;
    const sl = j.slope;
    const shifted = sl?.lift ? (sl.side === "a" ? 2 : 1) : 0;
    const g = new Float32Array([pa[0], pa[1], pb[0], pb[1], ps[0], ps[1], pf[0], pf[1], 1, 0, j.seam ? 1 : 0, sl?.lift ?? 0, shifted, 0, 0, 0]);
    const inst = { g, w: this.sheets.fw, h: this.sheets.fh };
    if (!this.sumsFor(g, inst)) return null;
    this.insts.set(key, inst);
    this.stats.boundaries++;
    return inst;
  }
  /** A composed ramp or a lined flat top under `key` (its full shape made). */
  ramp(key: string, t: RampTile): DirectInst | null {
    const hit = this.insts.get(key);
    if (hit) return hit;
    const j = t.job;
    const full = rampFullShape(this.sheets, t);
    const sk = rampJobShapeKey(j);
    let mk = this.mapSlot.get(sk);
    if (!mk) this.mapSlot.set(sk, (mk = hashBytes(full.map, full.rows)));
    const pm = this.slot(this.maps, mk, () => full.map);
    const pr = pm && this.slot(this.rows, mk, () => full.rows);
    if (!pm || !pr || pm[0] !== pr[0] || pm[1] !== pr[1]) return null;
    const pband = this.plate(plateIdOf(j.band), t.band);
    let pa: [number, number] | null = [0, 0], pb: [number, number] | null = [0, 0], pbs: [number, number] | null = [0, 0], pf: [number, number] | null = [0, 0];
    let kind = 0, seam = 0;
    if (j.top.kind === "plate") pa = this.plate(plateIdOf(j.top.side), t.top!);
    else {
      const bj = j.top.job;
      kind = 1;
      seam = bj.seam ? 1 : 0;
      pa = this.plate(plateIdOf(bj.a), t.a!);
      pb = this.plate(plateIdOf(bj.b), t.b!);
      pbs = this.slot(this.shared.shapes, shapeKey(bj), () => shapeOf(this.sheets, bj, t.a, t.b));
      pf = this.slot(this.shared.frames, String(bj.frame), () => frameTile(this.sheets, bj.frame));
    }
    if (!pband || !pa || !pb || !pbs || !pf) return null;
    this.syncLut();
    // a lined flat top paints on its own cheap path (compL, mode 3)
    const mode = j.mask === LINED_PLATE && j.top.kind === "plate" ? 3 : 2;
    const g = new Float32Array([pa[0], pa[1], pb[0], pb[1], pm[0], pm[1], pband[0], pband[1], mode, 0, seam, kind, pbs[0], pbs[1], pf[0], pf[1]]);
    const inst = { g, w: this.sheets.fw, h: full.h };
    if (!this.sumsFor(g, inst)) return null;
    this.insts.set(key, inst);
    this.stats.ramps++;
    return inst;
  }
  /** Shade rows met since the last sync, uploaded (each once, ever). */
  private syncLut(): void {
    if (this.lutRows >= SHADE_ROWS.length) return;
    if (SHADE_ROWS.length > TONE_ROW) throw new Error(`tiles3gpu: ${SHADE_ROWS.length} shade rows, the table holds ${TONE_ROW}`);
    const n = SHADE_ROWS.length - this.lutRows;
    const data = new Uint8Array(n * 256 * 4);
    for (let r = 0; r < n; r++) data.set(shadeRowBytes(this.lutRows + r), r * 256 * 4);
    this.upload(this.lut, 0, this.lutRows, 256, n, data);
    this.lutRows = SHADE_ROWS.length;
  }
  get pendingSums(): number { return this.pending.length; }
  /** Bind the resident textures to units 1..7 (unit 0 left active) and set the
   *  program's sampler and size uniforms. */
  bindUnits(set: (name: string, unit: number, w: number, h: number) => void): void {
    const gl = this.gl, sh = this.shared;
    const all: [string, WebGLTexture, number, number][] = [
      ["uPlates", sh.plates.tex, sh.plates.w, sh.plates.h],
      ["uShapes", sh.shapes.tex, sh.shapes.w, sh.shapes.h],
      ["uFrames", sh.frames.tex, sh.frames.w, sh.frames.h],
      ["uMaps", this.maps.tex, this.maps.w, this.maps.h],
      ["uRows", this.rows.tex, this.rows.w, this.rows.h],
      ["uLut", this.lut, 256, LUT_ROWS],
      ["uSums", this.sums, SUMS_COLS * 3, SUMS_ROWS],
    ];
    all.forEach(([name, t, w, h], i) => {
      gl.activeTexture(gl.TEXTURE1 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      set(name, i + 1, w, h);
    });
    gl.activeTexture(gl.TEXTURE0);
  }
  /** THE SUMS OF EVERY TILE FIRST SEEN since the last pass, into the resident
   *  sums texture — raw GL; the caller restores the renderer's state after. */
  sumsPass(): number {
    const N = this.pending.length;
    if (!N) return 0;
    const gl = this.gl, { fh } = this.sheets;
    const W = SUMS_COLS * 3;
    const v = new Float32Array(N * 6 * 20);
    let o = 0;
    for (const inst of this.pending) {
      const k = inst.g[9];
      const x0 = (k % SUMS_COLS) * 3, y0 = Math.floor(k / SUMS_COLS);
      const corner = (x: number, y: number, lx: number) => {
        v[o] = x; v[o + 1] = y; v[o + 2] = lx; v[o + 3] = 0;
        v.set(inst.g, o + 4);
        o += 20;
      };
      corner(x0, y0, 0); corner(x0 + 3, y0, 3); corner(x0, y0 + 1, 0);
      corner(x0 + 3, y0, 3); corner(x0 + 3, y0 + 1, 3); corner(x0, y0 + 1, 0);
    }
    this.pending = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sums, 0);
    gl.viewport(0, 0, W, SUMS_ROWS);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    const p = this.prog;
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STREAM_DRAW);
    const names: [string, number, number][] = [["aPos", 2, 0], ["aLocal", 2, 2], ["aG0", 4, 4], ["aG1", 4, 8], ["aG2", 4, 12], ["aG3", 4, 16]];
    const locs: number[] = [];
    for (const [n, size, off] of names) {
      const loc = gl.getAttribLocation(p, n);
      if (loc < 0) continue;
      locs.push(loc);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 80, off * 4);
    }
    gl.uniform2f(gl.getUniformLocation(p, "uTarget"), W, SUMS_ROWS);
    gl.uniform1f(gl.getUniformLocation(p, "uFH"), fh);
    this.bindUnits((name, unit, w, h) => {
      gl.uniform1i(gl.getUniformLocation(p, name), unit);
      const sz = gl.getUniformLocation(p, name + "Size");
      if (sz) gl.uniform2f(sz, w, h);
    });
    // the sums texture is the target: take it off its sampler unit for the draw
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.drawArrays(gl.TRIANGLES, 0, o / 20);
    for (const loc of locs) gl.disableVertexAttribArray(loc);
    this.stats.sumsPasses++;
    this.stats.sumsTiles += N;
    return N;
  }
}

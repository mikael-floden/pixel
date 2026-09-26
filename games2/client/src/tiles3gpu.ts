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
import {
  buildBoundaryPixels,
  buildPlatePixels,
  buildRampPixels,
  withEdge,
  rint,
  newPixels,
  EDGE_ALPHA,
  EDGE_ALPHA_IN,
  EDGE_SHADE,
  EDGE_SHADE_IN,
  type ComposeJob,
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
class SlotAtlas {
  readonly tex: WebGLTexture;
  readonly w: number;
  readonly h: number;
  private slots = new Map<string, number>();
  private readonly cap: number;
  private readonly cols: number;
  constructor(private gl: WebGLRenderingContext, private fw: number, private fh: number, size = 2048) {
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
  get size(): number {
    return this.slots.size;
  }
  private at(k: number): [number, number] {
    return [(k % this.cols) * this.fw, Math.floor(k / this.cols) * this.fh];
  }
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
  constructor(gl: WebGLRenderingContext, private sheets: PatternSheets) {
    this.gl = gl;
    const { fw, fh, tone } = sheets;
    this.pA = compile(gl, VERT, FRAG_A);
    this.pB = compile(gl, VERT, FRAG_B.replace("__FH__", String(fh)).replace("__FW__", String(fw)));
    this.pC = compile(gl, VERT, FRAG_C);
    this.buf = gl.createBuffer()!;
    this.fb = gl.createFramebuffer()!;
    this.plates = new SlotAtlas(gl, fw, fh);
    this.shapes = new SlotAtlas(gl, fw, fh);
    this.frames = new SlotAtlas(gl, fw, fh, 1024);
    const lut = new Uint8Array(256 * 4);
    for (let v = 0; v < 256; v++) { lut[v * 4] = rint(v * tone); lut[v * 4 + 3] = 255; }
    this.tone = texture(gl, 256, 1, lut);
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
      const pa = this.plates.origin(ia, () => u8(t.a));
      const pb = this.plates.origin(ib, () => u8(t.b));
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
  examples: { key: string; texels: number; first: { x: number; y: number; cpu: number[]; gpu: number[] } }[];
}

/** THE GATE: every boundary job seen, composed by the CPU (the worker's own
 *  functions over the same decoded files) and by the GPU, compared byte for
 *  byte — all four channels, every texel, transparent ones included. */
export async function gpuParity(sheets: PatternSheets, max = 4000): Promise<ParityReport> {
  const jobs = [...seenJobs.values()].slice(-max);
  const rep: ParityReport = { jobs: jobs.length, unsupported: 0, failedInputs: 0, compared: 0, identical: 0, tilesDiffering: 0, texelsDiffering: 0, maxDiff: 0, gpuMs: 0, opaque: 0, inked: 0, slopes: 0, examples: [] };
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
  const out: Pixels[] = [];
  for (let i = 0; i < tiles.length; i += GpuBoundaries.BATCH) out.push(...gpu.compose(tiles.slice(i, i + GpuBoundaries.BATCH)));
  rep.gpuMs = +gpu.stats.ms.toFixed(1);
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
  private flushQueued = false;
  private plates = new Map<string, Pixels | Promise<Pixels>>();
  private src = new Map<string, Promise<Pixels>>();
  readonly stats = { queued: 0, composed: 0, batches: 0, ms: 0, shapeMs: 0, fellBack: 0, waitingPlates: 0, uploads: { plates: 0, shapes: 0, frames: 0 }, error: "" };
  constructor(
    private inner: { ready(): boolean; compose(job: ComposeJob): void },
    private sheets: () => PatternSheets | null,
    private host: () => GpuHost | null,
  ) {}
  ready(): boolean {
    return this.inner.ready();
  }
  get pending(): number {
    return this.queue.length;
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
      if (this.queue.length > this.stats.waitingPlates) this.schedule();
    });
  }
  private plateOf(s: BoundaryJob["a"], sheets: PatternSheets): Pixels | null {
    const id = `${sideId(s)}|${s.wall.join(",")}`;
    const hit = this.plates.get(id);
    if (hit && !(hit instanceof Promise)) return hit;
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
    if (!this.queue.length || !sheets || !host) return 0;
    if (!this.on) { this.giveBack(); return 0; }
    let landed = 0;
    host.clear();
    try {
      if (!this.gpu) this.gpu = new GpuBoundaries(host.gl, sheets);
      const gl = host.gl, gpu = this.gpu, { fw, fh } = sheets;
      const s0 = performance.now();
      for (let b = 0; b < batches && this.queue.length; b++) {
        const take: GpuTile[] = [], later: BoundaryJob[] = [];
        let waiting = 0;
        for (const j of this.queue) {
          if (take.length >= GpuBoundaries.BATCH) { later.push(j); continue; }
          const a = this.plateOf(j.a, sheets), bb = this.plateOf(j.b, sheets);
          if (!a || !bb) { later.push(j); waiting++; continue; }
          if (!gpuShapeReady(sheets, j) && performance.now() - s0 > shapeMs) { later.push(j); continue; }
          shapeOf(sheets, j, a, bb);
          take.push({ a, b: bb, job: j });
        }
        this.stats.waitingPlates = waiting;
        this.queue = later;
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
  }
}

/** Is this job's shape already made (no CPU work to compose it)? */
function gpuShapeReady(sheets: PatternSheets, j: BoundaryJob): boolean {
  return !!shapeMemo.get(sheets)?.has(shapeKey(j));
}

async function buildPlate(sheets: PatternSheets, s: BoundaryJob["a"], src: Pixels): Promise<Pixels> {
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
  /** Per texel: the shade table row of a top texel (-1 none). */
  row: Int32Array;
  /** Per row: [red/blue shade, green shade] and its 256-entry tables. */
  shades: [number, number][];
  lut: Uint8Array; // rows x 256 x 4: r/b rounding in R, g rounding in G
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
  const shades: [number, number][] = [];
  const rowOf = new Map<string, number>();
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
      const k = `${srb},${sg}`;
      let rw = rowOf.get(k);
      if (rw === undefined) { rw = shades.push([srb, sg]) - 1; rowOf.set(k, rw); }
      row[i] = rw;
    }
  }
  const lut = new Uint8Array(shades.length * 256 * 4);
  shades.forEach(([srb, sg], r) => {
    for (let d = 0; d < 256; d++) {
      const o = (r * 256 + d) * 4;
      lut[o] = Math.round(d * srb);
      lut[o + 1] = Math.round(d * sg);
      lut[o + 3] = 255;
    }
  });
  const shape: RampShape = { w: W, h: H, map, row, shades, lut };
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
      const r = shape.row[i] * 256 * 4;
      o[i * 4] = shape.lut[r + src.data[s] * 4];
      o[i * 4 + 1] = shape.lut[r + src.data[s + 1] * 4 + 1];
      o[i * 4 + 2] = shape.lut[r + src.data[s + 2] * 4];
    } else {
      o[i * 4] = src.data[s]; o[i * 4 + 1] = src.data[s + 1]; o[i * 4 + 2] = src.data[s + 2];
    }
    o[i * 4 + 3] = shape.map[i * 4 + 3];
  }
  return out;
}

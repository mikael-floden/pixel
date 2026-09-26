/**
 * THE VIEW TURN — a 90-degree camera orbit built from the renderer's OWN frames.
 *
 * The game can only DRAW four orientations (the pixel art is 2D). The turn
 * between two of them is produced here, on an overlay canvas, from exactly two
 * frames the real renderer drew: A (before) and B (after). The terrain's real
 * height field — one box per cell, decks as slabs — is textured by PROJECTING
 * those frames onto it from the cameras that took them, and the camera orbits.
 *
 *  - EXACT AT BOTH ENDS. When the render camera equals the camera a frame was
 *    taken from, every fragment samples its own pixel: the first frame of the
 *    turn IS frame A and the last IS frame B, whatever the mesh looks like. The
 *    overlay appears and disappears without a pop.
 *  - REAL PARALLAX BETWEEN. Cliffs, stairs and bridges are geometry, so they
 *    turn as solids instead of skewing like a warped photo.
 *  - A DEPTH TEST PER FRAME stops a cliff's pixels being painted onto the ground
 *    it hid: a fragment reads A only where A actually saw it, B only where B did.
 *  - What is still wrong mid-turn (a tree or a body is not in the mesh, so its
 *    pixels lie on the ground behind it) is blurred along the ground plane's own
 *    elliptical arc, strongest at mid-turn where the error is largest.
 *
 * Geometry is in VIEW-GRID units of frame A: a point (X, Y) in cells, H in
 * levels. The game projects it to world px as
 *   wx = ox + 32 + (X - Y) * dx,   wy = oy + 10 + (X + Y) * dy - H * lh
 * (the diamond's top vertex sits at +(32, TOP_Y=10) inside a cell's art box),
 * and to canvas px as ((wx - camX) * zoom, (wy - camY) * zoom). An orthographic
 * orbit about a vertical axis through the pivot P is that same projection of
 * P + Rot(phi)(p - P): the game's own camera, turned.
 */

export interface RotProjector {
  ox: number; oy: number; dx: number; dy: number; lh: number;
  camX: number; camY: number; zoom: number;
  /** canvas backing size, px */
  w: number; h: number;
}

export interface RotMesh {
  /** xyz triples in A's view grid: X, Y (cells), H (levels) */
  pos: Float32Array;
  /** vertex count */
  n: number;
}

/** Build the height field around the pivot: one top face per cell, a wall on
 *  every side whose neighbour is lower (one quad per exposed side — the texture
 *  comes from the projected frame, not from tiled art), and each deck as a slab. */
export function buildRotMesh(
  levelAt: (col: number, row: number) => number | null,
  decks: { level: number; thickness?: number; cells: { col: number; row: number }[] }[],
  cx: number, cy: number, radius: number, gridW: number, gridH: number,
): RotMesh {
  const out: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => { out.push(...a, ...b, ...c, ...a, ...c, ...d); };
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(gridW - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(gridH - 1, Math.ceil(cy + radius));
  const L = (c: number, r: number) => (c < x0 || r < y0 || c > x1 || r > y1 ? null : levelAt(c, r));
  const floor = -2; // a closed slab under the window's edge
  for (let r = y0; r <= y1; r++) for (let c = x0; c <= x1; c++) {
    const l = levelAt(c, r);
    if (l === null) continue;
    quad([c, r, l], [c + 1, r, l], [c + 1, r + 1, l], [c, r + 1, l]);
    const sides: [number, number, number[], number[]][] = [
      [c + 1, r, [c + 1, r], [c + 1, r + 1]],
      [c - 1, r, [c, r + 1], [c, r]],
      [c, r + 1, [c + 1, r + 1], [c, r + 1]],
      [c, r - 1, [c, r], [c + 1, r]],
    ];
    for (const [nc, nr, e0, e1] of sides) {
      const nl = L(nc, nr);
      const bot = nl === null ? floor : nl;
      if (bot >= l) continue;
      quad([e0[0], e0[1], l], [e1[0], e1[1], l], [e1[0], e1[1], bot], [e0[0], e0[1], bot]);
    }
  }
  for (const d of decks) {
    const top = d.level, bot = Math.max(0, d.level - Math.max(d.thickness ?? 1, 0.4));
    const own = new Set(d.cells.map((q) => q.row * 100000 + q.col));
    for (const q of d.cells) {
      const c = q.col, r = q.row;
      if (c < x0 || r < y0 || c > x1 || r > y1) continue;
      quad([c, r, top], [c + 1, r, top], [c + 1, r + 1, top], [c, r + 1, top]);
      const sides: [number, number, number[], number[]][] = [
        [c + 1, r, [c + 1, r], [c + 1, r + 1]], [c - 1, r, [c, r + 1], [c, r]],
        [c, r + 1, [c + 1, r + 1], [c, r + 1]], [c, r - 1, [c, r], [c + 1, r]],
      ];
      for (const [nc, nr, e0, e1] of sides) {
        if (own.has(nr * 100000 + nc)) continue;
        quad([e0[0], e0[1], top], [e1[0], e1[1], top], [e1[0], e1[1], bot], [e0[0], e0[1], bot]);
      }
    }
  }
  return { pos: new Float32Array(out), n: out.length / 3 };
}

/* ---- shaders ----------------------------------------------------------- */

// Shared transform: p -> canvas px under a camera turned by (cos,sin) about the
// pivot, then shifted by `uShift` px (the difference between where the pivot
// sits in frame B and in frame A, lerped in as the turn proceeds).
const XFORM = `
uniform vec4 uIso;     // ox+32, oy+10, dx, dy
uniform vec4 uCam;     // camX, camY, zoom, lh
uniform vec2 uSize;    // canvas px
uniform vec2 uPivot;   // P, view grid
vec2 toPx(vec3 p, vec2 cs, vec2 shift){
  vec2 d = p.xy - uPivot;
  vec2 q = uPivot + vec2(cs.x*d.x - cs.y*d.y, cs.y*d.x + cs.x*d.y);
  float wx = uIso.x + (q.x - q.y)*uIso.z;
  float wy = uIso.y + (q.x + q.y)*uIso.w - p.z*uCam.w;
  return vec2((wx - uCam.x)*uCam.z, (wy - uCam.y)*uCam.z) + shift;
}
// Orthographic depth along the view direction: larger = nearer the viewer.
float nearness(vec3 p, vec2 cs){
  vec2 d = p.xy - uPivot;
  vec2 q = vec2(cs.x*d.x - cs.y*d.y, cs.y*d.x + cs.x*d.y);
  return q.x + q.y + p.z * (2.0*uIso.w/uCam.w);
}
vec4 clipOf(vec2 px, float near){
  return vec4(px.x/uSize.x*2.0-1.0, 1.0-px.y/uSize.y*2.0, clamp(-near/400.0, -1.0, 1.0), 1.0);
}
`;

// Pass 1 & 2: a depth map as seen from frame A's or frame B's camera, packed
// into RGBA8 (WebGL1 has no depth texture without an extension).
const DEPTH_VS = `attribute vec3 aP; ${XFORM}
uniform vec2 uCS; uniform vec2 uShift; varying float vNear;
void main(){ vNear = nearness(aP, uCS); gl_Position = clipOf(toPx(aP, uCS, uShift), vNear); }`;
const DEPTH_FS = `precision highp float; varying float vNear;
vec4 pack(float v){ vec4 e = fract(v * vec4(1.0, 255.0, 65025.0, 16581375.0)); return e - e.yzww * vec4(1.0/255.0,1.0/255.0,1.0/255.0,0.0); }
void main(){ gl_FragColor = pack(clamp(vNear/800.0 + 0.5, 0.0, 0.9999)); }`;

// Pass 3: the turned scene, textured by projecting A and B.
const MAIN_VS = `attribute vec3 aP; ${XFORM}
uniform vec2 uCS; uniform vec2 uShift;          // the camera NOW
uniform vec2 uCSB; uniform vec2 uShiftB;        // frame B's camera
uniform vec3 uZoom;                             // x, y: the pivot on screen; z: scale (1 = none)
varying vec2 vA; varying vec2 vB; varying float vNearA; varying float vNearB;
void main(){
  vec2 pa = toPx(aP, vec2(1.0, 0.0), vec2(0.0));   // where frame A drew this point
  vec2 pb = toPx(aP, uCSB, uShiftB);                // where frame B drew it
  vA = pa / uSize; vB = pb / uSize;
  vNearA = nearness(aP, vec2(1.0, 0.0)); vNearB = nearness(aP, uCSB);
  float near = nearness(aP, uCS);
  vec2 px = toPx(aP, uCS, uShift);
  gl_Position = clipOf(uZoom.xy + (px - uZoom.xy) * uZoom.z, near);
}`;
const MAIN_FS = `precision highp float;
uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uDA; uniform sampler2D uDB;
uniform float uMix; uniform float uHasB; uniform float uSoft; uniform float uDim;
varying vec2 vA; varying vec2 vB; varying float vNearA; varying float vNearB;
float unpack(vec4 c){ return dot(c, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0)); }
bool inside(vec2 uv){ return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
float feather(vec2 uv){ vec2 e = min(uv, 1.0 - uv); return smoothstep(0.0, 0.05, min(e.x, e.y)); }
void main(){
  // A snapshot's row 0 is the canvas TOP; a render target's row 0 is its BOTTOM.
  float sa = unpack(texture2D(uDA, vec2(vA.x, 1.0 - vA.y)));
  float sb = unpack(texture2D(uDB, vec2(vB.x, 1.0 - vB.y)));
  float eps = 1.5/800.0;                               // ~1.5 cells of slack
  float okA = inside(vA) && (vNearA/800.0 + 0.5) >= sa - eps ? 1.0 : 0.0;
  float okB = uHasB > 0.5 && inside(vB) && (vNearB/800.0 + 0.5) >= sb - eps ? 1.0 : 0.0;
  vec3 ca = texture2D(uA, vA).rgb, cb = texture2D(uB, vB).rgb;
  // A FRAME'S BORDER IS FEATHERED: seen-and-sharp meets the soft fill below over
  // a band, not along a hard line.
  float sA = okA * feather(vA), sB = okB * feather(vB);
  float wA = (1.0 - uMix) * sA, wB = uMix * sB;
  vec3 seen = wA + wB >= 1e-4 ? (ca*wA + cb*wB) / (wA + wB) : vec3(0.0);
  float cover = wA + wB >= 1e-4 ? max(sA, sB) : 0.0;
  if (cover >= 0.999) { gl_FragColor = vec4(seen, 1.0); return; }
  // SEEN BY NEITHER FRAME (ground that was off both screens). A clamped sample
  // repeats one edge texel into a long streak; this takes the frame nearer in time,
  // AVERAGES the edge region around the clamped point, and dims with the distance
  // outside, so the periphery reads as blurred motion instead of stretched pixels.
  bool useA = uMix < 0.5 || uHasB < 0.5;
  vec2 uv = useA ? vA : vB;
  vec2 cl = clamp(uv, vec2(0.0), vec2(1.0));
  // 3x3 at twice the spacing: the 5x5's reach for 9 reads instead of 25 — this
  // runs over the whole unseen area, which is largest mid-turn, on a phone GPU
  vec3 acc = vec3(0.0);
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    vec2 q = clamp(cl + vec2(float(i), float(j)) * (2.0 * uSoft), vec2(0.0), vec2(1.0));
    acc += useA ? texture2D(uA, q).rgb : texture2D(uB, q).rgb;
  }
  float away = length(uv - cl);
  vec3 fill = acc / 9.0 * (1.0 - uDim * smoothstep(0.0, 0.35, away));
  gl_FragColor = vec4(mix(fill, seen, cover), 1.0);
}`;

// Pass 4: blur along the ground plane's rotation about the pivot on SCREEN —
// an ellipse, because the plane is seen obliquely: screen offset s -> M(d) s with
// M(d) = [[cos d, -(dx/dy) sin d], [(dy/dx) sin d, cos d]] (det 1).
const POST_VS = `attribute vec2 aQ; varying vec2 vQ; void main(){ vQ = aQ; gl_Position = vec4(aQ*2.0-1.0, 0.0, 1.0); }`;
const POST_FS = `precision highp float;
uniform sampler2D uT; uniform vec2 uSize; uniform vec2 uPivotPx; uniform float uArc; uniform float uAspect;
uniform sampler2D uA; uniform sampler2D uB; uniform float uEdge; // 0 = mesh render, -1 = frame A, +1 = frame B
uniform float uVig; // vignette strength NOW (0 at both ends)
varying vec2 vQ;
void main(){
  vec2 s = vec2(vQ.x, 1.0 - vQ.y) * uSize;            // canvas px, y down
  vec2 d = s - uPivotPx;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.0;
    float a = uArc * (t - 0.5);                          // centred on the current angle
    float c = cos(a), sn = sin(a);
    vec2 q = uPivotPx + vec2(c*d.x - uAspect*sn*d.y, (sn/uAspect)*d.x + c*d.y);
    float w = 1.0 - 1.2*abs(t - 0.5);
    acc += texture2D(uT, vec2(q.x/uSize.x, 1.0 - q.y/uSize.y)).rgb * w; wsum += w;
  }
  vec3 col = acc / wsum;
  vec2 cc = (s / uSize - 0.5) * vec2(uSize.x / uSize.y, 1.0);
  col *= 1.0 - uVig * smoothstep(0.18, 0.62, length(cc));
  // At the two ends the overlay IS the frame, pixel for pixel.
  vec2 uv = s / uSize;
  if (uEdge < 0.0) col = mix(col, texture2D(uA, uv).rgb, -uEdge);
  if (uEdge > 0.0) col = mix(col, texture2D(uB, uv).rgb, uEdge);
  gl_FragColor = vec4(col, 1.0);
}`;

// Pass 3b: THE BODY AT THE PIVOT. The player stands on the orbit's axis, so on
// screen it only follows its feet; smeared onto the ground it vanished mid-turn.
// Its pixels are the DIFFERENCE between a frame and the same frame rendered
// without it (so the crop at a waterline, the light and the name all come
// along), drawn as a screen quad at the feet's depth: terrain in front hides it
// exactly as the painter did.
const BODY_VS = `attribute vec2 aQ;
uniform vec2 uSize; uniform vec4 uRect; uniform vec2 uOff; uniform vec3 uZoom;
uniform float uNearFeet; uniform float uFeetY; uniform float uHk;
varying vec2 vUV; varying vec2 vPx;
void main(){
  vec2 px = uRect.xy + aQ * uRect.zw;                  // in the frame it was taken in
  vUV = px / uSize; vPx = px;
  vec2 at = px + uOff;                                 // ...carried by the feet
  at = uZoom.xy + (at - uZoom.xy) * uZoom.z;           // and the mesh's zoom pulse
  // A BILLBOARD STANDS: a pixel h above the feet is h above the ground, and is
  // as near as the mesh makes a point that high (nearness's height term). At
  // the feet' depth alone, a wall behind a body was nearer than the body at
  // head height and cut every head off mid-turn.
  float near = uNearFeet + max(0.0, uFeetY - px.y) * uHk;
  gl_Position = vec4(at.x/uSize.x*2.0-1.0, 1.0-at.y/uSize.y*2.0, clamp(-near/400.0, -1.0, 1.0), 1.0);
}`;
const BODY_FS = `precision highp float;
uniform sampler2D uWith; uniform sampler2D uWithout; uniform float uAlpha;
uniform vec4 uSpr; uniform float uPart; // the sprite's own rect; 0 = the sprite's pixels, 1 = the rest (labels)
uniform sampler2D uOwn; uniform vec3 uOwnCol; uniform float uOwnMode; // -1 = no map; 0 = mine; 1 = mine or nobody's
varying vec2 vUV; varying vec2 vPx;
void main(){
  // ONLY WHAT THE FRAME SAW: a thing half off the edge has a rect past it, and a
  // clamped sample there smeared the edge column into a striped block mid-turn
  if (any(lessThan(vUV, vec2(0.0))) || any(greaterThan(vUV, vec2(1.0)))) discard;
  bool inSpr = vPx.x >= uSpr.x && vPx.y >= uSpr.y && vPx.x < uSpr.x + uSpr.z && vPx.y < uSpr.y + uSpr.w;
  if (inSpr != (uPart < 0.5)) discard;
  if (uOwnMode > -0.5) {
    // THE OWNER MAP (read back top row first, as the frame is uploaded): a pixel
    // the painter gave another thing is not mine
    vec4 o = texture2D(uOwn, vUV);
    bool mine = o.a > 0.5 && all(lessThan(abs(o.rgb - uOwnCol), vec3(0.03)));
    if (!(mine || (uOwnMode > 0.5 && o.a < 0.5))) discard;
  }
  vec3 a = texture2D(uWith, vUV).rgb, b = texture2D(uWithout, vUV).rgb;
  float d = abs(a.r-b.r) + abs(a.g-b.g) + abs(a.b-b.b);
  float m = smoothstep(0.04, 0.12, d) * uAlpha;
  if (m < 0.01) discard;
  gl_FragColor = vec4(a, m);
}`;

/* ---- the overlay -------------------------------------------------------- */

/** The body in one frame: its screen rect there (canvas px) and its feet in
 *  A's view grid (X, Y cells, H levels) — the same world point for A and B. */
export interface RotBody {
  rect: [number, number, number, number];
  /** the sprite's own rect: its pixels sort at the feet; the rest of `rect` (the
   *  name, the coordinates) draws on top, as the game draws labels */
  sprite: [number, number, number, number];
  foot: [number, number, number];
  /** its colour in the frame's OWNER MAP (0..1), which settles every overlap */
  own?: [number, number, number];
  /** WHO it is, the same in A and B ("p:<session>", "n:<npc>", "m:<monster>",
   *  "s:<feet>"): a thing only one frame saw keeps its one card all turn */
  id?: string;
}

export interface RotFxStart {
  frameA: TexImageSource;
  /** The same frame without the player (RotBody): the ground is textured with
   *  this, so the body leaves no ghost on it. Absent = frameA. */
  frameA0?: TexImageSource;
  projA: RotProjector;
  pivot: { x: number; y: number; h: number };  // view grid of A
  mesh: RotMesh;
  /** +1 = one quarter-turn clockwise on screen, -1 = counter-clockwise */
  dir: 1 | -1;
}

/** THE LOOK'S DIALS. `blur` scales the arc (1 = 0.14 rad at peak angular speed);
 *  `zoom` is the peak of a zoom pulse about the pivot (0.1 = 10% closer at mid-turn,
 *  which keeps more of the screen on ground a frame actually saw); `soft` is the
 *  spread (uv) of the average that fills what neither frame saw, `dim` how much it
 *  darkens toward the far outside; `vignette` darkens the screen's rim at peak speed;
 *  `fade` is the HALF-WIDTH (turn progress) of the hand-over from A to B, centred on
 *  mid-turn where the blur peaks — A's motion lines grow into the middle, B's grow
 *  out of it, and the two meet there (maintainer 2026-09-26: "motion lines from the
 *  90° view to meet in the middle so the fade takes place at the max blur"). */
export interface RotTune { blur: number; zoom: number; soft: number; dim: number; vignette: number; fade: number }
export const ROT_TUNE_DEFAULT: RotTune = { blur: 1, zoom: 0.1, soft: 0.02, dim: 0.35, vignette: 0.28, fade: 0.06 };

export class RotFx {
  readonly canvas: HTMLCanvasElement;
  tune: RotTune = { ...ROT_TUNE_DEFAULT };
  private gl: WebGLRenderingContext;
  private progs: { depth: WebGLProgram; main: WebGLProgram; post: WebGLProgram; body: WebGLProgram };
  private tex: { A: WebGLTexture; B: WebGLTexture; A0: WebGLTexture; B0: WebGLTexture; AM: WebGLTexture; OA: WebGLTexture; OB: WebGLTexture; DA: WebGLTexture; DB: WebGLTexture; M: WebGLTexture };
  private hasOwn = { A: false, B: false };
  /** EVERY UPRIGHT THING, grouped where their rects overlap (so a pixel belongs
   *  to one billboard): bodies and standing scenery, in A and in B. `meA`/`meB`
   *  index the player's group. */
  private bodyA: RotBody[] = [];
  private bodyB: RotBody[] = [];
  private meA = -1;
  private meB = -1;
  /** The player's group again, the player at the facing BETWEEN A's and B's (the
   *  camera at 45 degrees), shot on A's camera like A. */
  private bodyM: RotBody | null = null;
  private fbo: { DA: WebGLFramebuffer; DB: WebGLFramebuffer; M: WebGLFramebuffer };
  private depthRb: WebGLRenderbuffer;
  private meshBuf: WebGLBuffer; private quadBuf: WebGLBuffer;
  private n = 0;
  private st: RotFxStart | null = null;
  private hasB = false;
  private shiftB: [number, number] = [0, 0];
  /** ms spent by each phase of the last turn, for the perf probes */
  readonly timings: Record<string, number> = {};

  constructor(over: HTMLCanvasElement, w: number, h: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = w; this.canvas.height = h;
    const r = over.getBoundingClientRect();
    // HIDDEN UNTIL IT HAS DRAWN: a fresh WebGL canvas composites blank, and
    // between chained quarters it lies over the one still showing the turn
    Object.assign(this.canvas.style, {
      position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      pointerEvents: "none", zIndex: "5", imageRendering: "pixelated", visibility: "hidden",
    } as CSSStyleDeclaration);
    const gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, depth: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("rotfx: no WebGL");
    this.gl = gl;
    const sh = (t: number, src: string) => { const s = gl.createShader(t)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("rotfx shader: " + gl.getShaderInfoLog(s)); return s; };
    const prog = (vs: string, fs: string) => { const p = gl.createProgram()!; gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("rotfx link: " + gl.getProgramInfoLog(p)); return p; };
    this.progs = { depth: prog(DEPTH_VS, DEPTH_FS), main: prog(MAIN_VS, MAIN_FS), post: prog(POST_VS, POST_FS), body: prog(BODY_VS, BODY_FS) };
    const mk = () => { const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t; };
    this.tex = { A: mk(), B: mk(), A0: mk(), B0: mk(), AM: mk(), OA: mk(), OB: mk(), DA: mk(), DB: mk(), M: mk() };
    gl.bindTexture(gl.TEXTURE_2D, this.tex.M);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.depthRb = gl.createRenderbuffer()!;
    this.sizeTargets(w, h);
    const fb = (t: WebGLTexture) => { const f = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb); return f; };
    this.fbo = { DA: fb(this.tex.DA), DB: fb(this.tex.DB), M: fb(this.tex.M) };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.meshBuf = gl.createBuffer()!;
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    document.body.appendChild(this.canvas);
  }

  /** The render targets (the two depth maps, the scene, the depth buffer) at
   *  w x h — or 1 x 1 while PARKED, so an idle overlay holds a context and its
   *  compiled programs and next to no memory. */
  private targetsW = 0;
  private sizeTargets(w: number, h: number) {
    const gl = this.gl;
    for (const k of ["DA", "DB", "M"] as const) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    this.targetsW = w;
  }

  /** Can this overlay turn a canvas of this size? (It keeps its own.) */
  fits(w: number, h: number): boolean { return this.canvas.width === w && this.canvas.height === h; }

  /** Over the game canvas again (the layout may have moved since it last drew). */
  place(over: HTMLCanvasElement): void {
    const r = over.getBoundingClientRect();
    Object.assign(this.canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  /** PARKED BETWEEN TURNS, NOT DESTROYED: a new WebGL context and four programs
   *  compiled on every tap were the first thing a turn did. Hidden, its frames
   *  and targets shrunk to 1 x 1 (two full-screen overlays held ~200 MB). */
  park(): void {
    const gl = this.gl;
    const one = new Uint8Array(4);
    for (const k of ["A", "B", "A0", "B0", "AM", "OA", "OB"] as const) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, one);
    }
    this.sizeTargets(1, 1);
    this.targetsW = 0;
    this.st = null; this.hasB = false;
    this.bodyA = []; this.bodyB = []; this.bodyM = null; this.meA = this.meB = -1; this.hasOwn = { A: false, B: false };
    Object.assign(this.canvas.style, { transition: "", opacity: "1", visibility: "hidden" });
  }

  private upload(t: WebGLTexture, src: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }

  private setXform(p: WebGLProgram, proj: RotProjector) {
    const gl = this.gl, st = this.st!;
    gl.uniform4f(gl.getUniformLocation(p, "uIso"), proj.ox + 32, proj.oy + 10, proj.dx, proj.dy);
    gl.uniform4f(gl.getUniformLocation(p, "uCam"), proj.camX, proj.camY, proj.zoom, proj.lh);
    gl.uniform2f(gl.getUniformLocation(p, "uSize"), proj.w, proj.h);
    gl.uniform2f(gl.getUniformLocation(p, "uPivot"), st.pivot.x, st.pivot.y);
  }

  private drawMesh(p: WebGLProgram) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf);
    const a = gl.getAttribLocation(p, "aP");
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 12, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.n);
    gl.disableVertexAttribArray(a);
  }

  private depthPass(fbo: WebGLFramebuffer, cs: [number, number], shift: [number, number]) {
    const gl = this.gl, st = this.st!, p = this.progs.depth;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, st.projA.w, st.projA.h);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(p); this.setXform(p, st.projA);
    gl.uniform2f(gl.getUniformLocation(p, "uCS"), cs[0], cs[1]);
    gl.uniform2f(gl.getUniformLocation(p, "uShift"), shift[0], shift[1]);
    this.drawMesh(p);
  }

  /** Frame A arrives: the overlay can now draw the turn's first frame, which IS A. */
  start(s: RotFxStart): void {
    const t0 = performance.now(), gl = this.gl;
    if (this.targetsW !== this.canvas.width) this.sizeTargets(this.canvas.width, this.canvas.height);
    this.st = s; this.hasB = false;
    this.upload(this.tex.A, s.frameA);
    this.upload(this.tex.A0, s.frameA0 ?? s.frameA);
    this.upload(this.tex.B, s.frameA); // until B lands
    this.upload(this.tex.B0, s.frameA0 ?? s.frameA);
    this.bodyA = []; this.bodyB = []; this.bodyM = null; this.meA = this.meB = -1; this.hasOwn = { A: false, B: false };
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuf);
    gl.bufferData(gl.ARRAY_BUFFER, s.mesh.pos, gl.STATIC_DRAW);
    this.n = s.mesh.n;
    this.depthPass(this.fbo.DA, [1, 0], [0, 0]);
    this.timings.startMs = +(performance.now() - t0).toFixed(1);
  }

  /** Where the pivot lands on screen in a frame taken with `proj`, turned by (c,s). */
  private pivotPx(proj: RotProjector, h: number, _cs: [number, number]): [number, number] {
    const st = this.st!;
    const X = st.pivot.x, Y = st.pivot.y;
    const wx = proj.ox + 32 + (X - Y) * proj.dx, wy = proj.oy + 10 + (X + Y) * proj.dy - h * proj.lh;
    return [(wx - proj.camX) * proj.zoom, (wy - proj.camY) * proj.zoom];
  }

  /** Frame B arrives. `pivotB` is where the SAME pivot sits in frame B's own
   *  view grid; the constant screen offset between "A's camera turned 90 degrees
   *  about P" and "B's actual camera" is measured at the pivot and lerped in. */
  setB(frameB: TexImageSource, projB: RotProjector, pivotB: { x: number; y: number; h: number }, frameB0?: TexImageSource, bodyB?: RotBody): void {
    const t0 = performance.now(), st = this.st!;
    this.upload(this.tex.B, frameB);
    this.upload(this.tex.B0, frameB0 ?? frameB);
    if (frameB0 && bodyB) { this.bodyB = [bodyB]; this.meB = 0; }
    const cs: [number, number] = [0, st.dir];
    const pa = this.pivotPx(st.projA, st.pivot.h, cs);
    const X = pivotB.x, Y = pivotB.y;
    const wx = projB.ox + 32 + (X - Y) * projB.dx, wy = projB.oy + 10 + (X + Y) * projB.dy - pivotB.h * projB.lh;
    const pb: [number, number] = [(wx - projB.camX) * projB.zoom, (wy - projB.camY) * projB.zoom];
    this.shiftB = [pb[0] - pa[0], pb[1] - pa[1]];
    this.depthPass(this.fbo.DB, cs, this.shiftB);
    this.hasB = true;
    this.timings.bMs = +(performance.now() - t0).toFixed(1);
  }

  /** Frame A again WITHOUT the upright things (one frame later, under the overlay). */
  setA0(frameA0: TexImageSource, bodies: RotBody[], me: number): void {
    this.upload(this.tex.A0, frameA0);
    this.bodyA = bodies; this.meA = me;
  }
  /** A frame's OWNER MAP: the upright things as flat colours in the painter's order
   *  (WorldScene.turnOwnerMap), as read back — Phaser's off-screen target reads top
   *  row first, the frames' own orientation (measured: flipped, every card was
   *  matched against a mirror image and discarded itself). */
  setOwners(which: "A" | "B", data: Uint8Array, w: number, h: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, which === "A" ? this.tex.OA : this.tex.OB);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.hasOwn[which] = true;
  }
  /** Frame A with the player turned to the facing between A's and B's; `body` is
   *  the player's group of A. */
  setAM(frameAM: TexImageSource, body: RotBody): void {
    this.upload(this.tex.AM, frameAM);
    this.bodyM = body;
  }
  /** Frame B again without the upright things. */
  setB0(frameB0: TexImageSource, bodies: RotBody[], me: number): void {
    this.upload(this.tex.B0, frameB0);
    this.bodyB = bodies; this.meB = me;
  }

  get ready(): boolean { return this.hasB; }

  /** XFORM's toPx on the CPU: a point of A's view grid -> canvas px under a camera
   *  turned by `cs` about the pivot and shifted by `shift`. */
  private gridPx(p: [number, number, number], cs: [number, number], shift: [number, number]): [number, number] {
    const st = this.st!, pr = st.projA, P = st.pivot;
    const dx = p[0] - P.x, dy = p[1] - P.y;
    const qx = P.x + cs[0] * dx - cs[1] * dy, qy = P.y + cs[1] * dx + cs[0] * dy;
    const wx = pr.ox + 32 + (qx - qy) * pr.dx, wy = pr.oy + 10 + (qx + qy) * pr.dy - p[2] * pr.lh;
    return [(wx - pr.camX) * pr.zoom + shift[0], (wy - pr.camY) * pr.zoom + shift[1]];
  }
  /** XFORM's nearness on the CPU (larger = nearer the viewer). */
  private nearness(p: [number, number, number], cs: [number, number]): number {
    const st = this.st!, pr = st.projA, P = st.pivot;
    const dx = p[0] - P.x, dy = p[1] - P.y;
    return cs[0] * dx - cs[1] * dy + (cs[1] * dx + cs[0] * dy) + p[2] * ((2 * pr.dy) / pr.lh);
  }

  /** Draw the turn at progress u in [0,1]. `blur` scales the arc (0 = none);
   *  `speedIn` is the angular speed as a share of a lone quarter's peak, when a
   *  driven turn knows it (a chain cruises through its quarters, a reversal slows
   *  to nothing mid-way) — absent, the eased clock's own sin(pi u). */
  draw(u: number, blur = 1, speedIn?: number): void {
    const gl = this.gl, st = this.st!;
    if (!st) return;
    const phi = (Math.PI / 2) * u * st.dir;
    const cs: [number, number] = [Math.cos(phi), Math.sin(phi)];
    const shift: [number, number] = [this.shiftB[0] * u, this.shiftB[1] * u];
    // pass 3 — the turned scene into M
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo.M);
    gl.viewport(0, 0, st.projA.w, st.projA.h);
    gl.clearColor(0.07, 0.07, 0.11, 1); gl.clearDepth(1); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const m = this.progs.main;
    gl.useProgram(m); this.setXform(m, st.projA);
    gl.uniform2f(gl.getUniformLocation(m, "uCS"), cs[0], cs[1]);
    gl.uniform2f(gl.getUniformLocation(m, "uShift"), shift[0], shift[1]);
    gl.uniform2f(gl.getUniformLocation(m, "uCSB"), 0, st.dir);
    gl.uniform2f(gl.getUniformLocation(m, "uShiftB"), this.shiftB[0], this.shiftB[1]);
    // THE FADE AT THE BLUR'S PEAK: A alone before it, B alone after (a fade across
    // half the turn laid the two views over each other and muddied both sets of lines)
    const fw = Math.max(0.005, Math.min(0.5, this.tune.fade));
    gl.uniform1f(gl.getUniformLocation(m, "uMix"), this.hasB ? smooth(0.5 - fw, 0.5 + fw, u) : 0);
    gl.uniform1f(gl.getUniformLocation(m, "uHasB"), this.hasB ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(m, "uSoft"), this.tune.soft);
    gl.uniform1f(gl.getUniformLocation(m, "uDim"), this.tune.dim);
    // the zoom pulse follows the turn's angular speed: none at either end
    const speed = speedIn !== undefined ? Math.max(0, Math.min(1.3, speedIn)) : Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
    const pvz = this.pivotPx(st.projA, st.pivot.h, cs);
    gl.uniform3f(gl.getUniformLocation(m, "uZoom"), pvz[0] + shift[0], pvz[1] + shift[1], 1 + this.tune.zoom * speed);
    const bind = (unit: number, t: WebGLTexture, name: string, p: WebGLProgram) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(p, name), unit); };
    bind(0, this.tex.A0, "uA", m); bind(1, this.tex.B0, "uB", m); bind(2, this.tex.DA, "uDA", m); bind(3, this.tex.DB, "uDB", m);
    this.drawMesh(m);
    // pass 3b — the body, at its feet' depth: A's facing, then the one between
    // (the camera at 45 degrees), then B's — the character seen from each side
    // in turn as the camera goes round it
    const three = !!this.bodyM && this.hasB && this.meA >= 0;
    // SOLID THROUGH EVERY HAND-OVER: the next card comes in OVER the last one
    // (drawn after it, `order`), and the last fades only once the next is whole —
    // two half-transparent layers read as a ghost dipping out mid-turn. The
    // player: A's facing, the one between, B's; everything else A -> B.
    const hb = this.hasB;
    // everything but the player hands over INSIDE the ground's fade: B's card comes
    // in over its first half, A's goes over its second
    const aOut = hb ? 1 - (three ? smooth(0.33, 0.40, u) : smooth(0.5, 0.5 + fw, u)) : 1;
    const mIn = three ? smooth(0.26, 0.33, u) : 0, mOut = three ? 1 - smooth(0.67, 0.74, u) : 0;
    const bIn = hb ? (three ? smooth(0.60, 0.67, u) : smooth(0.5 - fw, 0.5, u)) : 0;
    const oA = hb ? 1 - smooth(0.5, 0.5 + fw, u) : 1, oB = hb ? smooth(0.5 - fw, 0.5, u) : 0;
    // A THING ONLY ONE FRAME SAW has no card to hand over to: it keeps its own the
    // whole turn and the orbit carries it off (or on) screen — handed over at
    // mid-turn, a lamp leaving the view vanished in the middle of the screen. It
    // only fades at the far end (it moved, or went behind something, meanwhile).
    const idsA = new Set(this.bodyA.map((b) => b.id)), idsB = new Set(this.bodyB.map((b) => b.id));
    const onlyA = (b: RotBody) => hb && b.id !== undefined && !idsB.has(b.id);
    const onlyB = (b: RotBody) => b.id !== undefined && !idsA.has(b.id);
    const soloA = 1 - smooth(0.85, 1, u), soloB = smooth(0, 0.15, u);
    const feetNow = (b: RotBody) => this.gridPx([b.foot[0], b.foot[1], b.foot[2]], cs, shift);
    const drawBody = (b: RotBody, withT: WebGLTexture, withoutT: WebGLTexture, taken: [number, number], alpha: number, own: WebGLTexture | null, ownMode: number) => {
      if (alpha < 0.01) return;
      const now = feetNow(b), bp = this.progs.body;
      gl.useProgram(bp);
      gl.uniform2f(gl.getUniformLocation(bp, "uSize"), st.projA.w, st.projA.h);
      gl.uniform4f(gl.getUniformLocation(bp, "uRect"), b.rect[0], b.rect[1], b.rect[2], b.rect[3]);
      gl.uniform2f(gl.getUniformLocation(bp, "uOff"), now[0] - taken[0], now[1] - taken[1]);
      // the feet's depth under the camera NOW, a hair toward the viewer so the
      // ground they stand on never covers them, rising with each pixel's height
      // above the feet in the frame it was taken in (canvas px -> levels ->
      // nearness, as XFORM's nearness weighs p.z)
      const pr = st.projA;
      gl.uniform1f(gl.getUniformLocation(bp, "uNearFeet"), this.nearness([b.foot[0], b.foot[1], b.foot[2]], cs) + 0.6);
      gl.uniform1f(gl.getUniformLocation(bp, "uFeetY"), taken[1]);
      gl.uniform1f(gl.getUniformLocation(bp, "uHk"), (2 * pr.dy) / pr.lh / (pr.zoom * pr.lh));
      gl.uniform1f(gl.getUniformLocation(bp, "uAlpha"), alpha);
      gl.uniform3f(gl.getUniformLocation(bp, "uZoom"), pvz[0] + shift[0], pvz[1] + shift[1], 1 + this.tune.zoom * speed);
      bind(4, withT, "uWith", bp); bind(5, withoutT, "uWithout", bp);
      gl.uniform4f(gl.getUniformLocation(bp, "uSpr"), b.sprite[0], b.sprite[1], b.sprite[2], b.sprite[3]);
      const oc = b.own ?? [0, 0, 0];
      gl.uniform3f(gl.getUniformLocation(bp, "uOwnCol"), oc[0], oc[1], oc[2]);
      gl.uniform1f(gl.getUniformLocation(bp, "uOwnMode"), own && b.own ? ownMode : -1);
      if (own) bind(6, own, "uOwn", bp);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      const a = gl.getAttribLocation(bp, "aQ");
      gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 8, 0);
      for (const part of [0, 1]) {
        // the sprite sorts at its feet; its labels draw over everything
        if (part === 1) gl.disable(gl.DEPTH_TEST);
        gl.uniform1f(gl.getUniformLocation(bp, "uPart"), part);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.enable(gl.DEPTH_TEST);
      gl.disableVertexAttribArray(a);
      gl.disable(gl.BLEND);
    };
    // BACK TO FRONT, so the soft edges blend over what is behind them
    type Card = { b: RotBody; w: WebGLTexture; wo: WebGLTexture; taken: [number, number]; a: number; near: number; own: WebGLTexture | null; mode: number };
    const cards: Card[] = [];
    // `order` breaks a tie between the SAME thing's cards (same feet): later stage on top
    const add = (b: RotBody, w: WebGLTexture, wo: WebGLTexture, taken: [number, number], a: number, own: WebGLTexture | null, mode: number, order: number) => {
      if (a >= 0.01) cards.push({ b, w, wo, taken, a, near: this.nearness(b.foot, cs) + order * 1e-3, own, mode });
    };
    const ownA = this.hasOwn.A ? this.tex.OA : null, ownB = this.hasOwn.B ? this.tex.OB : null;
    this.bodyA.forEach((b, i) => add(b, this.tex.A, this.tex.A0, this.gridPx(b.foot, [1, 0], [0, 0]), onlyA(b) ? soloA : i === this.meA ? aOut : oA, ownA, 0, 0));
    // the in-between facing is shot with the player ALONE, so it needs no owner map
    if (three) add(this.bodyM!, this.tex.AM, this.tex.A0, this.gridPx(this.bodyM!.foot, [1, 0], [0, 0]), Math.min(mIn, mOut), null, -1, 1);
    this.bodyB.forEach((b, i) => add(b, this.tex.B, this.tex.B0, this.gridPx(b.foot, [0, st.dir], this.shiftB), onlyB(b) ? soloB : i === this.meB ? bIn : oB, ownB, 0, 2));
    cards.sort((x, y) => x.near - y.near);
    for (const c of cards) drawBody(c.b, c.w, c.wo, c.taken, c.a, c.own, c.mode);
    // pass 4 — blur along the ground-plane arc, onto the overlay
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    const p = this.progs.post;
    gl.useProgram(p);
    const pv = this.pivotPx(st.projA, st.pivot.h, cs);
    gl.uniform2f(gl.getUniformLocation(p, "uSize"), st.projA.w, st.projA.h);
    gl.uniform2f(gl.getUniformLocation(p, "uPivotPx"), pv[0] + shift[0], pv[1] + shift[1]);
    // angular speed of an ease-in-out turn peaks mid-way: the arc follows it
    // `blur` scales the arc; 1 = 0.14 rad at peak angular speed (0.22 read as a swirl wipe, not an orbit)
    gl.uniform1f(gl.getUniformLocation(p, "uArc"), blur * this.tune.blur * 0.14 * speed * st.dir);
    gl.uniform1f(gl.getUniformLocation(p, "uVig"), this.tune.vignette * speed);
    gl.uniform1f(gl.getUniformLocation(p, "uAspect"), st.projA.dx / st.projA.dy);
    const edge = u <= 0.06 ? -(1 - u / 0.06) : u >= 0.94 && this.hasB ? (u - 0.94) / 0.06 : 0;
    gl.uniform1f(gl.getUniformLocation(p, "uEdge"), edge);
    bind(0, this.tex.M, "uT", p); bind(1, this.tex.A, "uA", p); bind(2, this.tex.B, "uB", p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const a = gl.getAttribLocation(p, "aQ");
    gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 8, 0);
    gl.viewport(0, 0, st.projA.w, st.projA.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(a);
    if (this.canvas.style.visibility === "hidden") this.canvas.style.visibility = "visible";
  }

  destroy(): void {
    const gl = this.gl;
    for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    for (const f of Object.values(this.fbo)) gl.deleteFramebuffer(f);
    gl.deleteRenderbuffer(this.depthRb);
    gl.deleteBuffer(this.meshBuf); gl.deleteBuffer(this.quadBuf);
    for (const p of Object.values(this.progs)) gl.deleteProgram(p);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Ease-in-out for the turn's clock: slow start, fast middle, soft landing. */
export function easeTurn(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

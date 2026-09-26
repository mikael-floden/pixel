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
varying vec2 vA; varying vec2 vB; varying float vNearA; varying float vNearB;
void main(){
  vec2 pa = toPx(aP, vec2(1.0, 0.0), vec2(0.0));   // where frame A drew this point
  vec2 pb = toPx(aP, uCSB, uShiftB);                // where frame B drew it
  vA = pa / uSize; vB = pb / uSize;
  vNearA = nearness(aP, vec2(1.0, 0.0)); vNearB = nearness(aP, uCSB);
  float near = nearness(aP, uCS);
  gl_Position = clipOf(toPx(aP, uCS, uShift), near);
}`;
const MAIN_FS = `precision highp float;
uniform sampler2D uA; uniform sampler2D uB; uniform sampler2D uDA; uniform sampler2D uDB;
uniform float uMix; uniform float uHasB;
varying vec2 vA; varying vec2 vB; varying float vNearA; varying float vNearB;
float unpack(vec4 c){ return dot(c, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0)); }
bool inside(vec2 uv){ return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
void main(){
  // A snapshot's row 0 is the canvas TOP; a render target's row 0 is its BOTTOM.
  float sa = unpack(texture2D(uDA, vec2(vA.x, 1.0 - vA.y)));
  float sb = unpack(texture2D(uDB, vec2(vB.x, 1.0 - vB.y)));
  float eps = 1.5/800.0;                               // ~1.5 cells of slack
  float okA = inside(vA) && (vNearA/800.0 + 0.5) >= sa - eps ? 1.0 : 0.0;
  float okB = uHasB > 0.5 && inside(vB) && (vNearB/800.0 + 0.5) >= sb - eps ? 1.0 : 0.0;
  vec3 ca = texture2D(uA, vA).rgb, cb = texture2D(uB, vB).rgb;
  float wA = (1.0 - uMix) * okA, wB = uMix * okB;
  // Seen by neither frame: fall back to whichever frame is nearer in time; the
  // blur pass smooths it. Seen by one: that one, whatever the mix says.
  if (wA + wB < 1e-4) { wA = uMix < 0.5 || uHasB < 0.5 ? 1.0 : 0.0; wB = 1.0 - wA; }
  gl_FragColor = vec4((ca*wA + cb*wB) / (wA + wB), 1.0);
}`;

// Pass 4: blur along the ground plane's rotation about the pivot on SCREEN —
// an ellipse, because the plane is seen obliquely: screen offset s -> M(d) s with
// M(d) = [[cos d, -(dx/dy) sin d], [(dy/dx) sin d, cos d]] (det 1).
const POST_VS = `attribute vec2 aQ; varying vec2 vQ; void main(){ vQ = aQ; gl_Position = vec4(aQ*2.0-1.0, 0.0, 1.0); }`;
const POST_FS = `precision highp float;
uniform sampler2D uT; uniform vec2 uSize; uniform vec2 uPivotPx; uniform float uArc; uniform float uAspect;
uniform sampler2D uA; uniform sampler2D uB; uniform float uEdge; // 0 = mesh render, -1 = frame A, +1 = frame B
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
  // At the two ends the overlay IS the frame, pixel for pixel.
  vec2 uv = s / uSize;
  if (uEdge < 0.0) col = mix(col, texture2D(uA, uv).rgb, -uEdge);
  if (uEdge > 0.0) col = mix(col, texture2D(uB, uv).rgb, uEdge);
  gl_FragColor = vec4(col, 1.0);
}`;

/* ---- the overlay -------------------------------------------------------- */

export interface RotFxStart {
  frameA: TexImageSource;
  projA: RotProjector;
  pivot: { x: number; y: number; h: number };  // view grid of A
  mesh: RotMesh;
  /** +1 = one quarter-turn clockwise on screen, -1 = counter-clockwise */
  dir: 1 | -1;
}

export class RotFx {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private progs: { depth: WebGLProgram; main: WebGLProgram; post: WebGLProgram };
  private tex: { A: WebGLTexture; B: WebGLTexture; DA: WebGLTexture; DB: WebGLTexture; M: WebGLTexture };
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
    Object.assign(this.canvas.style, {
      position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      pointerEvents: "none", zIndex: "5", imageRendering: "pixelated",
    } as CSSStyleDeclaration);
    const gl = this.canvas.getContext("webgl", { alpha: false, antialias: false, depth: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("rotfx: no WebGL");
    this.gl = gl;
    const sh = (t: number, src: string) => { const s = gl.createShader(t)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("rotfx shader: " + gl.getShaderInfoLog(s)); return s; };
    const prog = (vs: string, fs: string) => { const p = gl.createProgram()!; gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("rotfx link: " + gl.getProgramInfoLog(p)); return p; };
    this.progs = { depth: prog(DEPTH_VS, DEPTH_FS), main: prog(MAIN_VS, MAIN_FS), post: prog(POST_VS, POST_FS) };
    const mk = () => { const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t; };
    this.tex = { A: mk(), B: mk(), DA: mk(), DB: mk(), M: mk() };
    for (const k of ["DA", "DB", "M"] as const) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex[k]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      if (k === "M") { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); }
    }
    this.depthRb = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
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
    this.st = s; this.hasB = false;
    this.upload(this.tex.A, s.frameA);
    this.upload(this.tex.B, s.frameA); // until B lands
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
  setB(frameB: TexImageSource, projB: RotProjector, pivotB: { x: number; y: number; h: number }): void {
    const t0 = performance.now(), st = this.st!;
    this.upload(this.tex.B, frameB);
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

  get ready(): boolean { return this.hasB; }

  /** Draw the turn at progress u in [0,1]. `blur` scales the arc (0 = none). */
  draw(u: number, blur = 1): void {
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
    gl.uniform1f(gl.getUniformLocation(m, "uMix"), this.hasB ? smooth(0.25, 0.75, u) : 0);
    gl.uniform1f(gl.getUniformLocation(m, "uHasB"), this.hasB ? 1 : 0);
    const bind = (unit: number, t: WebGLTexture, name: string, p: WebGLProgram) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(p, name), unit); };
    bind(0, this.tex.A, "uA", m); bind(1, this.tex.B, "uB", m); bind(2, this.tex.DA, "uDA", m); bind(3, this.tex.DB, "uDB", m);
    this.drawMesh(m);
    // pass 4 — blur along the ground-plane arc, onto the overlay
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST);
    const p = this.progs.post;
    gl.useProgram(p);
    const pv = this.pivotPx(st.projA, st.pivot.h, cs);
    gl.uniform2f(gl.getUniformLocation(p, "uSize"), st.projA.w, st.projA.h);
    gl.uniform2f(gl.getUniformLocation(p, "uPivotPx"), pv[0] + shift[0], pv[1] + shift[1]);
    // angular speed of an ease-in-out turn peaks mid-way: the arc follows it
    const speed = Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
    // `blur` scales the arc; 1 = 0.14 rad at peak angular speed (0.22 read as a swirl wipe, not an orbit)
    gl.uniform1f(gl.getUniformLocation(p, "uArc"), blur * 0.14 * speed * st.dir);
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

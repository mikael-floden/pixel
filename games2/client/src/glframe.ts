/** WHAT THE FRAME DID TO THE GPU — per frame, so a long frame can be read
 *  against the GL work it (or the frame before it) queued.
 *
 *  WHY. The section timers bill the JS that runs inside `update`, and a
 *  215 ms `groundSlice` frame runs the SAME JS as a 25 ms one — so the time is
 *  in the GL calls that JS makes (a bind, a flush, an allocation) blocking on
 *  the driver, or in work queued earlier and paid now. Neither is visible from
 *  a section total. This wraps the four places that work enters WebGL and
 *  splits every DynamicTexture bracket into its BEGIN (bind, clear, and the
 *  capture-target resize) and END (flush, blit, viewport reset), so a frame's
 *  record says whether the ms sat in JS painting or in the driver.
 *
 *  Wrapped: DynamicTexture.beginDraw/endDraw (per texture key: count, begin ms,
 *  end ms — also pushed as the `glBegin` / `glEnd` sections, nested under the
 *  caller so they subtract from it and the frame still sums); the renderer's
 *  createTextureFromSource / deleteTexture / createFramebuffer /
 *  deleteFramebuffer (counts; the pool's capture switches ride along); and the
 *  context's texImage2D / texSubImage2D (bytes actually handed to the GPU).
 *
 *  Installed only with the perf beacon, like every other probe: measurement
 *  nobody reads is not paid for. */
import Phaser from "phaser";
import { captureFrameSwitches } from "./capturepool";
import { triFillPx } from "./perfextra";

export interface GlFrame {
  /** DynamicTexture key -> [brackets, begin ms, end ms]. */
  brk: Record<string, [number, number, number]>;
  texNew: number;
  texDel: number;
  fbNew: number;
  fbDel: number;
  upKb: number;
  capSw: number;
  /* THE GPU'S BILL, COUNTED AT THE API (2026-09-13). `dc` draw calls and `vt`
   * vertices; `fill` the megapixels the pipelines' triangles cover (the unit
   * a tiler pays in — perfextra.ts triFillPx, read off the vertex buffer at
   * BEFORE_FLUSH); `fillX` the same for draws that bypass a pipeline (Shader
   * objects, the utility blits — one viewport each, assumed full); `fb`
   * framebuffer switches (each one a tile flush on a Mali), `cl` clears with
   * their `clMpx`, and `rd` sync points (readPixels, getError, finish — a
   * round trip to the GPU process each). A long frame with a short `render`
   * and a big `fill` in the frame BEFORE it is the GPU-bound signature. */
  dc: number;
  vt: number;
  fill: number;
  fillX: number;
  fb: number;
  cl: number;
  clMpx: number;
  rd: number;
}

const fresh = (): GlFrame => ({ brk: {}, texNew: 0, texDel: 0, fbNew: 0, fbDel: 0, upKb: 0, capSw: 0, dc: 0, vt: 0, fill: 0, fillX: 0, fb: 0, cl: 0, clMpx: 0, rd: 0 });
let frame = fresh();
const win = { texNew: 0, texDel: 0, fbNew: 0, fbDel: 0, upKb: 0, dc: 0, dcMax: 0, fill: 0, fillMax: 0, fillX: 0, fb: 0, cl: 0, clMpx: 0, rd: 0, frames: 0 };
let installed = false;
// The current viewport, for the clears and the pipeline-less draws; whether a
// drawArrays is a pipeline flush (its fill was measured off the buffer) or not.
let vpW = 0;
let vpH = 0;
let inFlush = false;

const now = () => performance.now();
const kb = (w: number, h: number) => (w * h * 4) / 1024;

function brk(key: string): [number, number, number] {
  return (frame.brk[key] ??= [0, 0, 0]);
}

export function installGlFrameProbe(
  r: Phaser.Renderer.WebGL.WebGLRenderer | Phaser.Renderer.Canvas.CanvasRenderer,
  hooks: { ps(): void; pe(key: string): void },
): void {
  if (installed || r.type !== Phaser.WEBGL) return;
  installed = true;
  const renderer = r as Phaser.Renderer.WebGL.WebGLRenderer & Record<string, any>;

  // --- brackets ---------------------------------------------------------------
  const DT = Phaser.Textures.DynamicTexture.prototype as any;
  const oBegin = DT.beginDraw;
  const oEnd = DT.endDraw;
  DT.beginDraw = function (this: Phaser.Textures.DynamicTexture) {
    const t = now();
    hooks.ps();
    const out = oBegin.call(this);
    hooks.pe("glBegin");
    const b = brk(this.key);
    b[0]++;
    b[1] += now() - t;
    return out;
  };
  DT.endDraw = function (this: Phaser.Textures.DynamicTexture, erase?: boolean) {
    const t = now();
    hooks.ps();
    const out = oEnd.call(this, erase);
    hooks.pe("glEnd");
    brk(this.key)[2] += now() - t;
    return out;
  };

  // --- allocations ---------------------------------------------------------------
  const wrap = (name: string, on: (args: unknown[]) => void) => {
    const orig = renderer[name];
    if (typeof orig !== "function") return;
    renderer[name] = function (this: unknown, ...args: unknown[]) {
      on(args);
      return orig.apply(this, args);
    };
  };
  wrap("createTextureFromSource", () => {
    frame.texNew++;
    win.texNew++;
  });
  wrap("deleteTexture", () => {
    frame.texDel++;
    win.texDel++;
  });
  wrap("createFramebuffer", () => {
    frame.fbNew++;
    win.fbNew++;
  });
  wrap("deleteFramebuffer", () => {
    frame.fbDel++;
    win.fbDel++;
  });

  // --- bytes to the GPU ---------------------------------------------------------------
  const gl = renderer.gl as WebGLRenderingContext & Record<string, any>;
  const up = (k: number) => {
    frame.upKb += k;
    win.upKb += k;
  };
  const dims = (src: any): number => {
    if (!src) return 0;
    const w = src.naturalWidth ?? src.videoWidth ?? src.width ?? 0;
    const h = src.naturalHeight ?? src.videoHeight ?? src.height ?? 0;
    return kb(w, h);
  };
  const oTex = gl.texImage2D as (...a: any[]) => void;
  gl.texImage2D = function (this: WebGLRenderingContext, ...a: any[]) {
    // 9-arg: (target, level, ifmt, w, h, border, fmt, type, pixels); 6-arg: (target, level, ifmt, fmt, type, source)
    if (a.length >= 9) up(a[8] ? kb(a[3], a[4]) : 0);
    else up(dims(a[5]));
    return oTex.apply(this, a);
  };
  const oSub = gl.texSubImage2D as (...a: any[]) => void;
  gl.texSubImage2D = function (this: WebGLRenderingContext, ...a: any[]) {
    // 9-arg: (target, level, x, y, w, h, fmt, type, pixels); 7-arg: (target, level, x, y, fmt, type, source)
    if (a.length >= 9) up(kb(a[4], a[5]));
    else up(dims(a[6]));
    return oSub.apply(this, a);
  };

  // --- the GPU's bill, at the API ---------------------------------------------------------------
  const wrapGl = (name: string, on: (a: unknown[]) => void) => {
    const orig = gl[name];
    if (typeof orig !== "function") return;
    gl[name] = function (this: unknown, ...a: unknown[]) {
      on(a);
      return orig.apply(this, a);
    };
  };
  let lastFb: unknown = null;
  wrapGl("viewport", (a) => {
    vpW = a[2] as number;
    vpH = a[3] as number;
  });
  wrapGl("drawArrays", (a) => {
    frame.dc++;
    frame.vt += a[2] as number;
    if (!inFlush) frame.fillX += (vpW * vpH) / 1e6;
  });
  wrapGl("drawElements", (a) => {
    frame.dc++;
    frame.vt += a[1] as number;
    if (!inFlush) frame.fillX += (vpW * vpH) / 1e6;
  });
  wrapGl("bindFramebuffer", (a) => {
    if (a[1] !== lastFb) {
      lastFb = a[1];
      frame.fb++;
    }
  });
  wrapGl("clear", () => {
    frame.cl++;
    frame.clMpx += (vpW * vpH) / 1e6;
  });
  wrapGl("readPixels", () => frame.rd++);
  wrapGl("getError", () => frame.rd++);
  wrapGl("finish", () => frame.rd++);

  /* THE FILL, OFF THE VERTEX BUFFER. Every pipeline flush hands its triangles
   * to drawArrays; their screen area is right there in vertexViewF32 (the
   * position attribute, at its shader's offset and stride), and summing it
   * is a few hundred multiplies a frame. Only TRIANGLES topologies — a rope
   * strip would double-count — and only pipelines that have a 2-float
   * inPosition, which is every batcher the game draws with. */
  const pm = renderer.pipelines as unknown as { pipelines?: { each(fn: (k: string, p: unknown) => void): void } } | undefined;
  pm?.pipelines?.each((_k, p) => {
    const pipe = p as {
      on(e: string, cb: (...a: unknown[]) => void): void;
      vertexViewF32?: Float32Array;
      vertexCount?: number;
      topology?: number;
      currentShader?: { vertexSize?: number; attributes?: { name: string; size: number; offset: number }[] };
    };
    if (typeof pipe.on !== "function") return;
    pipe.on(Phaser.Renderer.WebGL.Pipelines.Events.BEFORE_FLUSH, () => {
      inFlush = true;
      const sh = pipe.currentShader;
      const view = pipe.vertexViewF32;
      const n = pipe.vertexCount ?? 0;
      if (!sh || !view || !sh.vertexSize || !sh.attributes || n < 3 || pipe.topology !== gl.TRIANGLES) return;
      let posOff = -1;
      for (const at of sh.attributes)
        if (at.name === "inPosition" && at.size === 2) {
          posOff = at.offset / 4;
          break;
        }
      if (posOff < 0) return;
      frame.fill += triFillPx(view, n, sh.vertexSize / 4, posOff) / 1e6;
    });
    pipe.on(Phaser.Renderer.WebGL.Pipelines.Events.AFTER_FLUSH, () => {
      inFlush = false;
    });
  });
}

/** The frame just closed; resets for the next. Compact: brackets with no time are dropped. */
export function glFrameTake(): GlFrame {
  const out = frame;
  out.capSw = captureFrameSwitches();
  frame = fresh();
  for (const k in out.brk) {
    const b = out.brk[k];
    b[1] = +b[1].toFixed(1);
    b[2] = +b[2].toFixed(1);
  }
  out.upKb = Math.round(out.upKb);
  // The window's GPU bill: sums, per-frame means at take time, and the peaks.
  win.frames++;
  win.dc += out.dc;
  if (out.dc > win.dcMax) win.dcMax = out.dc;
  win.fill += out.fill;
  if (out.fill > win.fillMax) win.fillMax = out.fill;
  win.fillX += out.fillX;
  win.fb += out.fb;
  win.cl += out.cl;
  win.clMpx += out.clMpx;
  win.rd += out.rd;
  out.fill = +out.fill.toFixed(2);
  out.fillX = +out.fillX.toFixed(2);
  out.clMpx = +out.clMpx.toFixed(2);
  return out;
}

/** Window totals for the beacon's counts; resets. The GPU counters are PER
 *  FRAME means (and peaks) so windows of different lengths compare. */
export function glWindowTake(): Record<string, number> {
  const n = Math.max(1, win.frames);
  const out = {
    glTexNew: win.texNew,
    glTexDel: win.texDel,
    glFbNew: win.fbNew,
    glFbDel: win.fbDel,
    glUpMb: +(win.upKb / 1024).toFixed(1),
    glDraws: +(win.dc / n).toFixed(1),
    glDrawsMax: win.dcMax,
    glFillMpx: +(win.fill / n).toFixed(2),
    glFillMax: +win.fillMax.toFixed(2),
    glFillXMpx: +(win.fillX / n).toFixed(2),
    glFbSw: +(win.fb / n).toFixed(1),
    glClears: +(win.cl / n).toFixed(1),
    glClearMpx: +(win.clMpx / n).toFixed(2),
    glReads: win.rd,
  };
  win.texNew = win.texDel = win.fbNew = win.fbDel = win.upKb = 0;
  win.dc = win.dcMax = win.fill = win.fillMax = win.fillX = win.fb = win.cl = win.clMpx = win.rd = win.frames = 0;
  return out;
}

/** Nothing but the steady per-frame draws: no bracket, allocation, upload or
 *  capture switch — the counters alone do not make a frame worth a `glPrev`. */
export const glFrameEmpty = (g: GlFrame): boolean =>
  !g.texNew && !g.texDel && !g.fbNew && !g.fbDel && !g.upKb && !g.capSw && Object.keys(g.brk).length === 0;

/** The counters of a frame, compact: zeros dropped, for the `glPrev` of a
 *  record that is otherwise empty — the frame before a long one paid its
 *  fill whether or not it opened a bracket. */
export function glFrameCounters(g: GlFrame): Record<string, number> {
  const out: Record<string, number> = { dc: g.dc, fill: g.fill };
  if (g.fillX) out.fillX = g.fillX;
  if (g.fb) out.fb = g.fb;
  if (g.cl) out.cl = g.cl;
  if (g.rd) out.rd = g.rd;
  return out;
}

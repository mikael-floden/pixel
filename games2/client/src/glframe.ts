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

export interface GlFrame {
  /** DynamicTexture key -> [brackets, begin ms, end ms]. */
  brk: Record<string, [number, number, number]>;
  texNew: number;
  texDel: number;
  fbNew: number;
  fbDel: number;
  upKb: number;
  capSw: number;
}

const fresh = (): GlFrame => ({ brk: {}, texNew: 0, texDel: 0, fbNew: 0, fbDel: 0, upKb: 0, capSw: 0 });
let frame = fresh();
const win = { texNew: 0, texDel: 0, fbNew: 0, fbDel: 0, upKb: 0 };
let installed = false;

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
  return out;
}

/** Window totals for the beacon's counts; resets. */
export function glWindowTake(): { glTexNew: number; glTexDel: number; glFbNew: number; glFbDel: number; glUpMb: number } {
  const out = { glTexNew: win.texNew, glTexDel: win.texDel, glFbNew: win.fbNew, glFbDel: win.fbDel, glUpMb: +(win.upKb / 1024).toFixed(1) };
  win.texNew = win.texDel = win.fbNew = win.fbDel = win.upKb = 0;
  return out;
}

export const glFrameEmpty = (g: GlFrame): boolean =>
  !g.texNew && !g.texDel && !g.fbNew && !g.fbDel && !g.upKb && !g.capSw && Object.keys(g.brk).length === 0;

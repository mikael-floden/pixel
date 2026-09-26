/* THE GROUND PIPELINE — the direct draw's half inside Phaser (tiles3gpu.ts
 * "THE DIRECT DRAW"). It IS Phaser's Single pipeline, the one a DynamicTexture
 * draws with, plus two per-quad vectors (the direct tile's four, packed —
 * tiles3gpu packG): a plain quad (a plate, a wall, a liquid) carries zeros and
 * is drawn exactly as before; a transition, a composed ramp or an outlined top
 * is ONE quad of the same batch whose vectors say what it is, and the shader
 * paints it from the resident inputs.
 *
 * ONE BATCH, PAINTER ORDER. The quads land in the ground's own batch in the
 * order the painter issues them, so a transition is covered by the cell in
 * front of it exactly as its texture was; and a direct quad never switches the
 * batch's texture (it reads unit 0 not at all), so it costs no draw call of
 * its own. Before a batch that holds a tile seen for the first time is drawn,
 * that tile's colour sums are drawn into the resident sums texture
 * (`GpuDirect.sumsPass`) and the renderer's state is put back. */
import Phaser from "phaser";
import { GROUND_FRAG, GROUND_VERT, type DirectInst, type GpuDirect } from "./tiles3gpu";

export const GROUND_PIPELINE = "MlGround";
const ZERO = new Float32Array(8);
type Wrap = Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;
type Matrix = Phaser.GameObjects.Components.TransformMatrix;
/** The pipeline internals this subclass writes (public at runtime, not typed). */
type Internals = {
  vertexViewF32: Float32Array;
  vertexViewU32: Uint32Array;
  vertexCount: number;
  currentBatch: { start: number; count: number } | null;
  currentShader: { vertexComponentCount: number; setAttribPointers(reset?: boolean): void };
  activeTextures: unknown[];
  activeBuffer: unknown;
  vertexBuffer: { webGLBuffer: WebGLBuffer };
  shouldFlush(n: number): boolean;
  setTexture2D(t?: Wrap): number;
  onBatch(go: unknown): void;
  currentUnit: number;
};

export class GroundPipeline extends Phaser.Renderer.WebGL.Pipelines.SinglePipeline {
  /** The resident store; null = every quad is plain. */
  direct: GpuDirect | null = null;
  /** The plate height (uFH). */
  fh = 46;
  private extra: Float32Array = ZERO;
  private m1 = new Phaser.GameObjects.Components.TransformMatrix();
  readonly stats = { direct: 0, sumsPasses: 0, sumsMs: 0 };

  constructor(game: Phaser.Game) {
    const F = Phaser.Renderer.WebGL.FLOAT;
    super({
      game,
      name: GROUND_PIPELINE,
      vertShader: GROUND_VERT,
      fragShader: GROUND_FRAG,
      attributes: [
        { name: "inPosition", size: 2 },
        { name: "inTexCoord", size: 2 },
        { name: "inTexId" },
        { name: "inTintEffect" },
        { name: "inTint", size: 4, type: Phaser.Renderer.WebGL.UNSIGNED_BYTE, normalized: true },
        { name: "inG0", size: 4, type: F },
        { name: "inG1", size: 4, type: F },
      ],
    } as Phaser.Types.Renderer.WebGL.WebGLPipelineConfig);
  }

  /** A DIRECT TILE: `inst` drawn at (x, y) of the target through `matrix` (the
   *  DynamicTexture's camera), its sub-rect (sx, sy, sw, sh) in tile texels. */
  batchDirect(inst: DirectInst, x: number, y: number, sx: number, sy: number, sw: number, sh: number, tint: number, matrix: Matrix): void {
    this.manager!.set(this);
    const q = this.m1.copyFrom(matrix).setQuad(x, y, x + sw, y + sh);
    const t = Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha(tint, 1);
    const me = this as unknown as Internals;
    this.extra = inst.p;
    // no texture of its own: it joins whatever batch is open (a fresh one only
    // when none is, on the white texture it never reads)
    this.batchQuad(null as never, q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], sx, sy, sx + sw, sy + sh, t, t, t, t, 0, me.currentBatch ? (undefined as never) : (this.renderer.whiteTexture as never), undefined as never);
    this.extra = ZERO;
    this.stats.direct++;
  }

  /** WebGLPipeline.batchQuad with the two packed vectors after Phaser's seven. */
  batchQuad(gameObject: Phaser.GameObjects.GameObject | null, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, u0: number, v0: number, u1: number, v1: number, tintTL: number, tintTR: number, tintBL: number, tintBR: number, tintEffect: number | boolean, texture?: Wrap, unit?: number): boolean {
    const me = this as unknown as Internals;
    if (unit === undefined) unit = me.currentUnit;
    let hasFlushed = false;
    if (me.shouldFlush(6)) {
      this.flush();
      hasFlushed = true;
    }
    if (!me.currentBatch) unit = me.setTexture2D(texture);
    const stride = me.currentShader.vertexComponentCount;
    const o = me.vertexCount * stride;
    const te = +tintEffect, un = unit as number;
    this.vert(o, x0, y0, u0, v0, un, te, tintTL);
    this.vert(o + stride, x1, y1, u0, v1, un, te, tintBL);
    this.vert(o + 2 * stride, x2, y2, u1, v1, un, te, tintBR);
    this.vert(o + 3 * stride, x0, y0, u0, v0, un, te, tintTL);
    this.vert(o + 4 * stride, x2, y2, u1, v1, un, te, tintBR);
    this.vert(o + 5 * stride, x3, y3, u1, v0, un, te, tintTR);
    me.vertexCount += 6;
    me.currentBatch!.count = me.vertexCount - me.currentBatch!.start;
    me.onBatch(gameObject);
    return hasFlushed;
  }

  private vert(o: number, x: number, y: number, u: number, v: number, unit: number, te: number, tint: number): void {
    const me = this as unknown as Internals;
    const f = me.vertexViewF32, g = this.extra;
    f[o] = x; f[o + 1] = y; f[o + 2] = u; f[o + 3] = v; f[o + 4] = unit; f[o + 5] = te;
    me.vertexViewU32[o + 6] = tint;
    for (let i = 0; i < 8; i++) f[o + 7 + i] = g[i];
  }

  /** Before the batch is drawn: the sums of any tile seen for the first time
   *  (raw GL into the sums texture, the renderer's state restored), then the
   *  resident textures on units 1..7 for this batch. */
  onBeforeFlush(): void {
    const d = this.direct;
    if (!d) return;
    const gl = this.gl, me = this as unknown as Internals;
    if (d.pendingSums) {
      const t0 = performance.now();
      const r = this.renderer as unknown as { currentFramebuffer: { webGLFramebuffer: WebGLFramebuffer } | null; currentProgram: { webGLProgram: WebGLProgram } };
      const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
      const caps = [gl.BLEND, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.DEPTH_TEST, gl.CULL_FACE].map((c) => [c, gl.isEnabled(c)] as const);
      d.sumsPass();
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.currentFramebuffer ? r.currentFramebuffer.webGLFramebuffer : null);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      for (const [c, on] of caps) if (on) gl.enable(c); else gl.disable(c);
      gl.useProgram(r.currentProgram.webGLProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, me.vertexBuffer.webGLBuffer);
      me.activeBuffer = me.vertexBuffer;
      me.currentShader.setAttribPointers(true);
      this.stats.sumsPasses++;
      this.stats.sumsMs += performance.now() - t0;
    }
    d.bindUnits((name, unit, w, h) => {
      this.set1i(name, unit);
      this.set2f(name + "Size", w, h);
    });
    this.set1f("uFH", this.fh);
    me.activeTextures.length = 0; // unit 0 is bound again by the flush
  }
}

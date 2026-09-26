/* THE WORLD CACHE'S TAKE ON THE GPU (worldcache.ts): a tile's box copied out
 * of the ground texture into a page slot, and the texels outside the tile's
 * diamond cleared — no readback, no bracket.
 *
 * WHY RAW GL. A DynamicTexture bracket is a capture clear and a blit of the
 * whole target (perf.md, THE BRACKET), and a take is a copy and an erase:
 * `copyTexSubImage2D` does the copy in the GPU's own memory, and four
 * triangles written with blending off do the erase, between Phaser's
 * `pipelines.clear()` and `rebind()` (its documented door for raw GL).
 *
 * WHY THE TRIANGLES ARE EXACT. The tile's diamond is inscribed in its box
 * (worldcache.ts `tileBoxOf`), and a texel is the tile's when the level-0 cell
 * under its CENTRE is (`tileMask`). GL covers a texel when its centre is inside
 * a triangle — and on the_game's lattice (dx 32, dy 14, a whole origin) no
 * texel centre lies ON a diamond edge (14x + 32y is even, the edge's constant
 * is odd), so the tie-breaking rule never decides: the four corner triangles
 * clear exactly the texels the mask says are not the tile's.
 *
 * ORIENTATION, MEASURED (glrows probe, Phaser 3.90, WebGL1): a render
 * texture stores image row y at GL row y — a marker filled at a fresh
 * DynamicTexture's top-left reads back at GL row 0, and the ground texture's
 * `snapshotPixel(x, y)` equals the raw GL pixel at row y, not at H - 1 - y. So
 * every rect here is the image's own, top-left, with no flip. (The bottom-up
 * rows of the snapshotArea trap are the SCREEN's, not a render texture's.) */

type GL = WebGLRenderingContext;

const VS = `attribute vec2 a_p;
uniform vec2 u_size;
void main() { gl_Position = vec4(a_p / u_size * 2.0 - 1.0, 0.0, 1.0); }`;
const FS = `precision mediump float;
void main() { gl_FragColor = vec4(0.0); }`;

export interface WcGlRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class WorldCacheGl {
  private prog: WebGLProgram | null = null;
  private buf: WebGLBuffer | null = null;
  private aPos = -1;
  private uSize: WebGLUniformLocation | null = null;
  private readonly tri = new Float32Array(24);

  constructor(private readonly gl: GL) {}

  private program(): boolean {
    if (this.prog && this.buf) return true;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, VS);
    const fs = sh(gl.FRAGMENT_SHADER, FS);
    const p = gl.createProgram();
    if (!vs || !fs || !p) return false;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return false;
    this.prog = p;
    this.aPos = gl.getAttribLocation(p, "a_p");
    this.uSize = gl.getUniformLocation(p, "u_size");
    this.buf = gl.createBuffer();
    return !!this.buf;
  }

  /** Copy `src` (top-left, in the source target) into the page at `dst`
   *  (top-left), then clear the four corners outside the box's inscribed
   *  diamond. The caller wraps this in Phaser's `pipelines.clear()` /
   *  `rebind()`. False when GL refused (a lost context). */
  take(srcFb: WebGLFramebuffer, src: WcGlRect, pageTex: WebGLTexture, pageFb: WebGLFramebuffer, pageW: number, pageH: number, dst: { x: number; y: number }): boolean {
    const gl = this.gl;
    if (gl.isContextLost() || !this.program()) return false;
    const { w, h } = src;
    // THE COPY: the source's framebuffer is the read side, the page texture the write side
    gl.bindFramebuffer(gl.FRAMEBUFFER, srcFb);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pageTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, dst.x, dst.y, src.x, src.y, w, h);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // THE ERASE: four corner triangles, in the page's own rows
    gl.bindFramebuffer(gl.FRAMEBUFFER, pageFb);
    gl.viewport(0, 0, pageW, pageH);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    const x0 = dst.x;
    const x1 = dst.x + w;
    const xm = dst.x + w / 2;
    const yTop = dst.y; // the box's top row
    const yBot = dst.y + h;
    const ym = (yTop + yBot) / 2;
    const t = this.tri;
    // top-left, top-right, bottom-right, bottom-left corners
    t.set([x0, yTop, xm, yTop, x0, ym, xm, yTop, x1, yTop, x1, ym, x1, ym, x1, yBot, xm, yBot, xm, yBot, x0, yBot, x0, ym]);
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, t, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.uSize, pageW, pageH);
    gl.drawArrays(gl.TRIANGLES, 0, 12);
    gl.disableVertexAttribArray(this.aPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /** A slot's texels cleared (before it is taken again, or let go). */
  clear(pageFb: WebGLFramebuffer, dst: WcGlRect): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pageFb);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(dst.x, dst.y, dst.w, dst.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** The context was lost: every GL object is gone with it. */
  lost(): void {
    this.prog = null;
    this.buf = null;
  }
}

/* THE WORLD CACHE ON THE GPU (worldcache.ts): a tile's box copied out of the
 * ground texture into a page slot with the texels outside the tile's diamond
 * cleared (the TAKE), and the pictures drawn back into a ground texture (the
 * DRAW) — no readback, no bracket.
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
 * WHY THE DRAW IS OURS, NOT PHASER'S. A picture is cut at its diamond with no
 * overlap, so it must land on the very texels it was taken from. Phaser's
 * sprite shaders place a quad at `precision mediump float` — 16 bits on his
 * Mali-G715 — which puts a whole-texel quad up to about a texel off, and
 * differently at each corner: the picture's edge lands a texel short and the
 * background fill shows through, the 1-texel lines along the tiles he
 * photographed (2026-09-26, 71 tiles). The ground's own ops hide the same
 * error in the texel of overlap every tile's art carries; a picture has none
 * to spare. Here the vertex language's default (highp) places the quad, and
 * each corner carries its page texel as a highp varying, so the texel a
 * fragment samples is its own texel's centre on every GPU; erased texels are
 * discarded, so they leave the target as it was.
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
const DRAW_VS = `attribute vec2 a_p;
attribute vec2 a_s;
uniform vec2 u_size;
uniform vec2 u_page;
varying highp vec2 v_s;
void main() {
  v_s = a_s / u_page;
  gl_Position = vec4(a_p / u_size * 2.0 - 1.0, 0.0, 1.0);
}`;
const DRAW_FS = `precision highp float;
uniform sampler2D u_tex;
varying highp vec2 v_s;
void main() {
  vec4 c = texture2D(u_tex, v_s);
  if (c.a < 0.5) discard;
  gl_FragColor = c;
}`;

export interface WcGlRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One picture's texels to draw: the target rect (whole texels, top-left
 *  rows) and the page texel that lands on its top-left. */
export interface WcGlDraw {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sx: number;
  sy: number;
}

export class WorldCacheGl {
  private prog: WebGLProgram | null = null;
  private buf: WebGLBuffer | null = null;
  private aPos = -1;
  private uSize: WebGLUniformLocation | null = null;
  private readonly tri = new Float32Array(24);
  private drawProg: WebGLProgram | null = null;
  private dPos = -1;
  private dSrc = -1;
  private dSize: WebGLUniformLocation | null = null;
  private dPage: WebGLUniformLocation | null = null;
  private dTex: WebGLUniformLocation | null = null;
  private quads = new Float32Array(24 * 8);

  constructor(private readonly gl: GL) {}

  private link(vsSrc: string, fsSrc: string): WebGLProgram | null {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, vsSrc);
    const fs = sh(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    if (!vs || !fs || !p) return null;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
  }

  private program(): boolean {
    if (this.prog && this.buf) return true;
    const gl = this.gl;
    const p = this.link(VS, FS);
    if (!p) return false;
    this.prog = p;
    this.aPos = gl.getAttribLocation(p, "a_p");
    this.uSize = gl.getUniformLocation(p, "u_size");
    this.buf = gl.createBuffer();
    return !!this.buf;
  }

  private drawProgram(): boolean {
    if (this.drawProg && this.buf) return true;
    if (!this.program()) return false;
    const gl = this.gl;
    const p = this.link(DRAW_VS, DRAW_FS);
    if (!p) return false;
    this.drawProg = p;
    this.dPos = gl.getAttribLocation(p, "a_p");
    this.dSrc = gl.getAttribLocation(p, "a_s");
    this.dSize = gl.getUniformLocation(p, "u_size");
    this.dPage = gl.getUniformLocation(p, "u_page");
    this.dTex = gl.getUniformLocation(p, "u_tex");
    return true;
  }

  /** The draw needs highp in the fragment shader (a 32-bit texel coordinate);
   *  a GPU without it gets no cache, never a picture drawn a texel off. */
  canDraw(): boolean {
    const gl = this.gl;
    if (gl.isContextLost()) return false;
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    return !!hp && hp.precision >= 23 && this.drawProgram();
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

  /** Draw one page's pictures into the target framebuffer (w x h): each
   *  rect's texels become the page's, texel for texel, except where the page
   *  is erased. Blending off, so a drawn texel is replaced exactly. The
   *  caller wraps this in Phaser's `pipelines.clear()` / `rebind()`. False
   *  when GL refused (a lost context). */
  draw(fb: WebGLFramebuffer, w: number, h: number, pageTex: WebGLTexture, pageW: number, pageH: number, rects: WcGlDraw[]): boolean {
    const gl = this.gl;
    if (gl.isContextLost() || !this.drawProgram()) return false;
    if (!rects.length) return true;
    // six vertices a rect, (target x, y, page x, y) each
    if (this.quads.length < rects.length * 24) this.quads = new Float32Array(rects.length * 24);
    const q = this.quads;
    let k = 0;
    for (const r of rects) {
      const sx1 = r.sx + (r.x1 - r.x0);
      const sy1 = r.sy + (r.y1 - r.y0);
      for (const [x, y, s, t] of [
        [r.x0, r.y0, r.sx, r.sy],
        [r.x1, r.y0, sx1, r.sy],
        [r.x0, r.y1, r.sx, sy1],
        [r.x1, r.y0, sx1, r.sy],
        [r.x1, r.y1, sx1, sy1],
        [r.x0, r.y1, r.sx, sy1],
      ]) {
        q[k++] = x;
        q[k++] = y;
        q[k++] = s;
        q[k++] = t;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.useProgram(this.drawProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pageTex);
    // only this draw samples a page: its texels, never a blend of two
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.uniform1i(this.dTex, 0);
    gl.uniform2f(this.dSize, w, h);
    gl.uniform2f(this.dPage, pageW, pageH);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, q.subarray(0, k), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.dPos);
    gl.enableVertexAttribArray(this.dSrc);
    gl.vertexAttribPointer(this.dPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(this.dSrc, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLES, 0, k / 4);
    gl.disableVertexAttribArray(this.dPos);
    gl.disableVertexAttribArray(this.dSrc);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
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
    this.drawProg = null;
    this.buf = null;
  }
}

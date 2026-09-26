/* EVERY SHADER COMPILES HIGHP — THE MAINTAINER'S LAW (2026-09-26, on his phone:
 * "draw: full precision ON WORKS! NO Shimmer!" ... "this should not be
 * changed"). Never remove it, never gate it, never let a shader run mediump.
 *
 * All seven of Phaser 3.90's vertex shaders say `precision mediump float`
 * (Multi, Single, Mobile, Quad, Mesh, PointLight, BitmapMask), and 31 of its 34
 * shader sources are mediump through and through; only the three sprite
 * fragment shaders (Multi, Single, Mobile) take highp where the GPU has it. The
 * vertex stage is the one that places a sprite's corners and carries its atlas
 * UVs. GLSL ES lets mediump be 16-bit and his Mali-G715 runs it at 16, so a
 * corner lands up to ~0.9 px off on a 1500 px target and a UV rounds to 1/2048
 * of its atlas: the cache seams, the shimmer while moving, and every 1 px
 * overlap the tiles grew to hide them. A desktop or a headless run executes
 * mediump at 32 bits, so none of it shows there.
 *
 * `highpInstall` (main.ts, before any game exists) wraps the WebGL prototypes:
 * every shader this page compiles says `precision highp float` where it said
 * mediump or lowp — Phaser's and ours, vertex and fragment together (a uniform
 * both stages declare must agree on precision or the program does not link) —
 * wherever the fragment stage has real 32-bit floats (HIGH_FLOAT >= 23 bits);
 * elsewhere nothing is rewritten. A rewritten shader that fails to compile, or
 * a program that fails to link, gets back the source it was given: highp can
 * cost a shader its precision, never the game its shader.
 *
 * Structural types, not the DOM's: the server's tests import this. */

type Gl = {
  FRAGMENT_SHADER: number;
  HIGH_FLOAT: number;
  COMPILE_STATUS: number;
  LINK_STATUS: number;
  getShaderPrecisionFormat(stage: number, kind: number): { precision: number } | null;
  shaderSource(shader: object, src: string): void;
  compileShader(shader: object): void;
  getShaderParameter(shader: object, name: number): unknown;
  linkProgram(program: object): void;
  getProgramParameter(program: object, name: number): unknown;
  getAttachedShaders(program: object): object[] | null;
};
const env = () => globalThis as unknown as { WebGLRenderingContext?: { prototype: Gl }; WebGL2RenderingContext?: { prototype: Gl } };

/** A precision statement that is not highp. */
const LOW = /precision\s+(?:lowp|mediump)\s+float\s*;/g;

let installed = false;
let rewritten = 0;
let keptLow = 0;
let noHighp = false;

/** Whether THIS page compiles its shaders highp (the beacon's `counts.highp`):
 *  false only on a GPU without 32-bit fragment floats. */
export function highpRunning(): boolean {
  return installed && !noHighp;
}

/** Sources rewritten, and rewritten sources given back after a failed compile
 *  or link (the beacon's `counts.highpBack`), since boot. */
export function highpCounts(): { rewritten: number; back: number } {
  return { rewritten, back: keptLow };
}

/** Before any game exists. Wraps the WebGL prototypes, so every context and
 *  every recompile (a context restore) goes through it. */
export function highpInstall(): void {
  if (installed) return;
  installed = true;
  const g = env();
  for (const C of [g.WebGLRenderingContext, g.WebGL2RenderingContext]) {
    const proto = C?.prototype;
    if (!proto) continue;
    const { shaderSource, compileShader, linkProgram } = proto;
    const can = new WeakMap<object, boolean>();
    /** A rewritten shader -> the source it was given. */
    const given = new WeakMap<object, string>();
    const giveBack = (gl: Gl, shader: object): void => {
      const src = given.get(shader);
      if (src === undefined) return;
      given.delete(shader);
      keptLow++;
      shaderSource.call(gl, shader, src);
      compileShader.call(gl, shader);
    };
    proto.shaderSource = function (this: Gl, shader: object, src: string): void {
      let ok = can.get(this);
      if (ok === undefined) {
        try {
          ok = (this.getShaderPrecisionFormat(this.FRAGMENT_SHADER, this.HIGH_FLOAT)?.precision ?? 0) >= 23;
        } catch {
          ok = false;
        }
        can.set(this, ok);
        if (!ok) noHighp = true;
      }
      const out = ok ? src.replace(LOW, "precision highp float;") : src;
      if (out !== src) {
        given.set(shader, src);
        rewritten++;
      } else given.delete(shader);
      shaderSource.call(this, shader, out);
    };
    proto.compileShader = function (this: Gl, shader: object): void {
      compileShader.call(this, shader);
      if (given.has(shader) && !this.getShaderParameter(shader, this.COMPILE_STATUS)) giveBack(this, shader);
    };
    proto.linkProgram = function (this: Gl, program: object): void {
      linkProgram.call(this, program);
      const mine = (this.getAttachedShaders(program) ?? []).filter((s) => given.has(s));
      if (!mine.length || this.getProgramParameter(program, this.LINK_STATUS)) return;
      for (const s of mine) giveBack(this, s);
      linkProgram.call(this, program);
    };
  }
}

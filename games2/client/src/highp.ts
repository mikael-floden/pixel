/* FULL PRECISION DRAWING (games-perf 2026-09-26; the maintainer: "I actually think
 * this is the reason we have shimmering in the game and the reason we have needed
 * to make tiles larger than they should need to be").
 *
 * All seven of Phaser 3.90's vertex shaders say `precision mediump float`
 * (Multi, Single, Mobile, Quad, Mesh, PointLight, BitmapMask), and 31 of its 34
 * shader sources are mediump through and through; only the three sprite
 * fragment shaders (Multi, Single, Mobile) take highp where the GPU has it. The
 * vertex stage is the one that places a sprite's corners and carries its atlas
 * UVs. GLSL ES lets mediump be 16-bit and his Mali-G715 runs it at 16, so a
 * corner lands up to ~0.9 px off on a 1500 px texture and a UV rounds to 1/2048
 * of its atlas. The cache seams were exactly this (worldcachegl.ts, "WHY THE DRAW
 * IS OURS"). A desktop or a headless run executes mediump at 32 bits, so none of
 * it shows there.
 *
 * ON (Settings->Dev "draw: full precision", localStorage `ml-highp` "1"): every
 * shader this page compiles says `precision highp float` where it said mediump
 * or lowp: Phaser's and ours, vertex and fragment together (a uniform both stages
 * declare must agree on precision or the program does not link). Only where the
 * fragment stage has real 32-bit floats (HIGH_FLOAT >= 23 bits); elsewhere
 * nothing is rewritten. A rewritten shader that fails to compile, or a program
 * that fails to link, gets back the source it was given: the switch can cost a
 * shader its highp, never the game its shader (it is read at boot, and a boot
 * that fails never reaches the Dev page that turns it off). Phaser compiles its
 * pipelines when the game is made, so a press applies from the next load. OFF
 * (the default): nothing is wrapped.
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
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const env = () =>
  globalThis as unknown as { WebGLRenderingContext?: { prototype: Gl }; WebGL2RenderingContext?: { prototype: Gl }; localStorage?: Store };

const KEY = "ml-highp";

/** A precision statement that is not highp. */
const LOW = /precision\s+(?:lowp|mediump)\s+float\s*;/g;

let running = false;
let rewritten = 0;
let keptLow = 0;
let noHighp = false;

/** The stored choice: what the NEXT load takes. A page without storage reads off. */
export function highpStored(): boolean {
  try {
    return env().localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Store the choice for the next load (the Settings->Dev press). */
export function setHighp(on: boolean): void {
  try {
    env().localStorage?.setItem(KEY, on ? "1" : "0");
  } catch {
    /* no storage: the press cannot outlive the page, and says so by not changing state */
  }
}

/** Whether THIS page compiles its shaders highp (the beacon's `counts.highp`). */
export function highpRunning(): boolean {
  return running && !noHighp;
}

/** Before any game exists. Wraps the WebGL prototypes, so every context and
 *  every recompile (a context restore) goes through it. */
export function highpInstall(): void {
  if (running || !highpStored()) return;
  running = true;
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

/** The Settings->Dev state: what this page runs, and what a reload brings when
 *  the stored choice differs. */
export function highpState(): string {
  const next = highpStored();
  if (noHighp) return "no 32-bit floats here: off";
  const now = running ? `on (${rewritten} shaders${keptLow ? `, ${keptLow} kept their own` : ""})` : "off";
  return next === running ? now : `${now}, ${next ? "on" : "off"} after reload`;
}

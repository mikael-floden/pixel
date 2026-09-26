// FULL PRECISION DRAWING (client/src/highp.ts) — what a phone cannot be asked to
// prove: off wraps nothing; on, every mediump/lowp float precision a shader is
// given becomes highp; and a rewritten shader that fails to compile, or a
// program that fails to link, gets back the source it was given — the switch is
// read at boot, and a boot that fails never reaches the Dev page that turns it
// off. The GL here is a fake that fails on demand: a source carrying
// `NO_COMPILE_HI` does not compile highp, one carrying `NO_LINK_HI` does not link highp.
import { test } from "node:test";
import assert from "node:assert/strict";

type Sh = { src: string; ok: boolean };
type Prog = { shaders: Sh[]; ok: boolean; links: number };
const store = new Map<string, string>();
class FakeGl {
  FRAGMENT_SHADER = 1;
  HIGH_FLOAT = 2;
  COMPILE_STATUS = 3;
  LINK_STATUS = 4;
  highBits = 23;
  getShaderPrecisionFormat() {
    return { precision: this.highBits };
  }
  shaderSource(s: Sh, src: string) {
    s.src = src;
  }
  compileShader(s: Sh) {
    s.ok = !(s.src.includes("NO_COMPILE_HI") && s.src.includes("precision highp"));
  }
  getShaderParameter(s: Sh) {
    return s.ok;
  }
  linkProgram(p: Prog) {
    p.links++;
    p.ok = p.shaders.every((s) => s.ok && !(s.src.includes("NO_LINK_HI") && s.src.includes("precision highp")));
  }
  getProgramParameter(p: Prog) {
    return p.ok;
  }
  getAttachedShaders(p: Prog) {
    return p.shaders;
  }
}
const g = globalThis as unknown as { WebGLRenderingContext?: unknown; localStorage?: unknown };
g.WebGLRenderingContext = FakeGl;
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
const plain = { shaderSource: FakeGl.prototype.shaderSource, compileShader: FakeGl.prototype.compileShader, linkProgram: FakeGl.prototype.linkProgram };

const { highpInstall, highpRunning, highpState, setHighp } = await import("../../client/src/highp.js");

const VS = "#define SHADER_NAME T_VS\nprecision mediump float;\nattribute vec2 p;\nvoid main(){gl_Position=vec4(p,0.0,1.0);}";
const FS = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision lowp float;\n#endif\nvoid main(){gl_FragColor=vec4(1.0);}";
const build = (gl: FakeGl, vs: string, fs: string) => {
  const a: Sh = { src: "", ok: false }, b: Sh = { src: "", ok: false };
  gl.shaderSource(a, vs);
  gl.shaderSource(b, fs);
  gl.compileShader(a);
  gl.compileShader(b);
  const p: Prog = { shaders: [a, b], ok: false, links: 0 };
  gl.linkProgram(p);
  return { a, b, p };
};

test("off: nothing is wrapped and nothing is rewritten", () => {
  highpInstall();
  assert.equal(FakeGl.prototype.shaderSource, plain.shaderSource);
  assert.equal(FakeGl.prototype.compileShader, plain.compileShader);
  assert.equal(FakeGl.prototype.linkProgram, plain.linkProgram);
  const { a } = build(new FakeGl(), VS, FS);
  assert.match(a.src, /precision mediump float;/);
  assert.equal(highpRunning(), false);
  assert.equal(highpState(), "off");
});

test("on: every mediump/lowp float precision becomes highp, vertex and fragment alike", () => {
  setHighp(true);
  assert.equal(highpState(), "off, on after reload");
  highpInstall();
  assert.equal(highpRunning(), true);
  const { a, b, p } = build(new FakeGl(), VS, FS);
  assert.doesNotMatch(a.src + b.src, /precision\s+(lowp|mediump)\s+float/);
  assert.equal(a.src, VS.replace("precision mediump float;", "precision highp float;"));
  assert.equal((b.src.match(/precision highp float;/g) ?? []).length, 2);
  assert.ok(p.ok);
  assert.equal(p.links, 1);
  assert.equal(highpState(), "on (2 shaders)");
});

test("a rewritten shader that does not compile gets back the source it was given", () => {
  const vs = VS + "\n// NO_COMPILE_HI";
  const { a, p } = build(new FakeGl(), vs, FS);
  assert.equal(a.src, vs);
  assert.ok(a.ok);
  assert.ok(p.ok);
  assert.equal(highpState(), "on (4 shaders, 1 kept their own)");
});

test("a program that does not link gets back every source it was given, and links", () => {
  const vs = VS + "\n// NO_LINK_HI";
  const { a, b, p } = build(new FakeGl(), vs, FS);
  assert.equal(a.src, vs);
  assert.equal(b.src, FS);
  assert.ok(p.ok);
  assert.equal(p.links, 2);
});

test("a source already highp is left alone, and the program it links into is not relinked", () => {
  const vs = "precision highp float;\nvoid main(){}";
  const fs = "precision highp float;\nvoid main(){}";
  const { a, b, p } = build(new FakeGl(), vs, fs);
  assert.equal(a.src, vs);
  assert.equal(b.src, fs);
  assert.equal(p.links, 1);
});

test("no 32-bit fragment floats: nothing is rewritten, and the Dev page says so", () => {
  const gl = new FakeGl();
  gl.highBits = 16;
  const { a, b } = build(gl, VS, FS);
  assert.equal(a.src, VS);
  assert.equal(b.src, FS);
  assert.equal(highpRunning(), false);
  assert.equal(highpState(), "no 32-bit floats here: off");
});

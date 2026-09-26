// FxGL — compiles effect layers and draws one layer box into whatever
// framebuffer is bound. Framework-free: the viewer and the Phaser adapter both
// draw through this, so a layer looks the same in the wiki and in the game.
//
// State hygiene (the Phaser adapter depends on it): draw() touches the
// program, ARRAY_BUFFER, vertex attrib 0 and blend; it never binds textures
// or framebuffers. The caller restores its own renderer afterwards.

import { VERT, fragmentSource, PRELUDE_LINES } from "./glsl.js";

const STD = [
  "uRect", "uAnchor", "uView", "uTime", "uLife", "uFade", "uLevel", "uLv", "uSeed", "uDir", "uGDir",
  "uLen", "uGround", "uBands", "uDither", "uBright", "uPx", "uScale", "uTint",
];

const ONE3 = [1, 1, 1];

export class FxGL {
  constructor(gl, opts = {}) {
    this.gl = gl;
    this.log = opts.log || ((m) => console.warn(m));
    this.programs = new Map(); // key -> { prog, unis: Map(name -> {loc,type,size}), broken }
    this.errors = new Map(); // key -> message (a broken shader is skipped, never thrown)
    this.quad = null;
    this.vs = null;
    this.init();
  }

  init() {
    const gl = this.gl;
    this.programs.clear();
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vs = this.compile(gl.VERTEX_SHADER, VERT, "vertex");
  }

  /** After a context restore every handle is dead: rebuild lazily. */
  restore() {
    this.errors.clear();
    this.init();
  }

  compile(type, src, name) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const msg = gl.getShaderInfoLog(sh) || "compile failed";
      gl.deleteShader(sh);
      throw new Error(`${name}: ${msg.trim()}`);
    }
    return sh;
  }

  /** The program for a layer — compiled once per (effect, layer). */
  program(key, body) {
    let p = this.programs.get(key);
    if (p) return p;
    const gl = this.gl;
    p = { prog: null, unis: new Map(), broken: false };
    try {
      const fs = this.compile(gl.FRAGMENT_SHADER, fragmentSource(body), key);
      const prog = gl.createProgram();
      gl.attachShader(prog, this.vs);
      gl.attachShader(prog, fs);
      gl.bindAttribLocation(prog, 0, "aPos");
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error(`${key}: link: ${gl.getProgramInfoLog(prog)}`);
      }
      gl.deleteShader(fs);
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(prog, i);
        if (!info) continue;
        const name = info.name.replace(/\[0\]$/, "");
        p.unis.set(name, { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size });
      }
      p.prog = prog;
    } catch (e) {
      p.broken = true;
      const msg = String(e.message || e);
      this.errors.set(key, msg);
      this.log(`[effects] shader ${msg} (effect lines start after the ${PRELUDE_LINES}-line prelude)`);
    }
    this.programs.set(key, p);
    return p;
  }

  setUniform(u, v) {
    const gl = this.gl;
    const loc = u.loc;
    switch (u.type) {
      case gl.FLOAT:
        if (u.size > 1) gl.uniform1fv(loc, v);
        else gl.uniform1f(loc, typeof v === "number" ? v : v[0]);
        break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, v); break;
      case gl.FLOAT_MAT2: gl.uniformMatrix2fv(loc, false, v); break;
      case gl.INT: case gl.BOOL: gl.uniform1i(loc, typeof v === "number" ? v : v ? 1 : 0); break;
      default: break;
    }
  }

  /** Draw one layer. `d` is a LayerDraw from FxWorld.drawList(); `view` maps
   *  world px to clip space: clip = world * view.xy + view.zw. Returns false
   *  when the layer's shader is broken (it is then simply not drawn). */
  draw(d, view, pxSnap = 0) {
    const gl = this.gl;
    const p = this.program(d.key, d.frag);
    if (p.broken || !p.prog) return false;
    gl.useProgram(p.prog);
    const unis = p.unis;
    const set = (name, v) => {
      const u = unis.get(name);
      if (u) this.setUniform(u, v);
    };
    set("uRect", [d.x, d.y, d.w, d.h]);
    set("uAnchor", [d.ax, d.ay]);
    set("uView", view);
    set("uPx", pxSnap);
    const s = d.std;
    for (let i = 3; i < STD.length; i++) {
      const k = STD[i];
      if (k === "uPx" || s[k] === undefined) continue;
      set(k, s[k]);
    }
    if (s.uTint === undefined) set("uTint", ONE3);
    for (const k in d.u) set(k, d.u[k]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  /** Compile every layer of a definition now (a wiki gate, or a warm-up
   *  before the first cast so the first fireball never hitches). */
  warm(def) {
    for (const L of def.layers) this.program(`${def.id}#${L.id}`, L.frag);
    return def.layers.every((L) => !this.programs.get(`${def.id}#${L.id}`).broken);
  }
}

/** Premultiplied "over": the one blend every layer uses. */
export function blendPremultiplied(gl) {
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}

/** clip = world * xy + zw for a target of (tw, th) px showing world rect
 *  (vx, vy) at `scale` target px per world px. flipY for a texture read
 *  back top-down (Phaser's convention for a framebuffer texture). */
export function viewMatrix(vx, vy, scale, tw, th, flipY = false) {
  const sx = (2 * scale) / tw;
  const sy = (flipY ? 2 : -2) * scale / th;
  return [sx, sy, -vx * sx - 1, flipY ? -vy * sy - 1 : -vy * sy + 1];
}

// THE STAGE — a small piece of the game's world to judge an effect on: the
// game's own iso projection (32/14 px per cell step, 32 wu per cell), a
// grass floor, the real hero and a real monster at the size the game draws
// them, and a night that works the way the game's does (the world darkens,
// emissive layers do not, the effect's light lights the floor).
//
// Rendering order is the painter's: ground, then ground-plane layers, then
// bodies and body-plane layers sorted by the ground y they stand on, then air
// and screen layers.

import { FxGL, blendPremultiplied, viewMatrix } from "../runtime/gl.js";

export const ISO = { dx: 32, dy: 14, cellWu: 32 };

const SPRITE_VS = `precision highp float;
attribute vec2 aPos;
uniform vec4 uRect; uniform vec4 uView;
varying vec2 vUv; varying vec2 vW;
void main() {
  vec2 w = uRect.xy + aPos * uRect.zw;
  vUv = aPos; vW = w;
  gl_Position = vec4(w * uView.xy + uView.zw, 0.0, 1.0);
}`;
const SPRITE_FS = `precision highp float;
uniform sampler2D uTex;
uniform vec3 uAmb;
uniform vec4 uL[4];
uniform vec3 uLc[4];
uniform float uFeetY;
uniform float uGround;
varying vec2 vUv; varying vec2 vW;
void main() {
  vec4 c = texture2D(uTex, vUv);
  vec2 sp = uGround > 0.5 ? vW : vec2(vW.x, uFeetY);
  vec3 L = uAmb;
  for (int i = 0; i < 4; i++) {
    if (uL[i].z <= 0.0) continue;
    vec2 d = (sp - uL[i].xy) * vec2(1.0, 2.2857);
    float f = clamp(1.0 - length(d) / uL[i].z, 0.0, 1.0);
    L += uLc[i] * f * f;
  }
  gl_FragColor = vec4(c.rgb * L, c.a);
}`;

export const NIGHT_AMBIENT = [0.2, 0.24, 0.4];

export class Stage {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: !!opts.preserve });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.fxgl = new FxGL(gl, { log: opts.log });
    this.origin = { x: 0, y: 0 }; // screen px of world (0, 0)
    this.sprites = [];
    this.groundTex = null;
    this.groundRect = null;
    this.spriteProg = this.makeSpriteProgram();
  }

  project(x, y) {
    const c = x / ISO.cellWu, r = y / ISO.cellWu;
    return { x: this.origin.x + (c - r) * ISO.dx, y: this.origin.y + (c + r) * ISO.dy };
  }
  /** Screen px -> world units on the (flat) ground. */
  unproject(sx, sy) {
    const a = (sx - this.origin.x) / ISO.dx, b = (sy - this.origin.y) / ISO.dy;
    return { x: ((a + b) / 2) * ISO.cellWu, y: ((b - a) / 2) * ISO.cellWu };
  }
  host(viewRect) {
    return { project: (x, y) => this.project(x, y), cellWu: ISO.cellWu, view: () => viewRect() };
  }

  makeSpriteProgram() {
    const gl = this.gl;
    const sh = (t, s) => {
      const o = gl.createShader(t);
      gl.shaderSource(o, s);
      gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
      return o;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, SPRITE_VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, SPRITE_FS));
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    const loc = (n) => gl.getUniformLocation(p, n);
    return { p, uRect: loc("uRect"), uView: loc("uView"), uTex: loc("uTex"), uAmb: loc("uAmb"), uL: loc("uL"), uLc: loc("uLc"), uFeetY: loc("uFeetY"), uGround: loc("uGround") };
  }

  texture(source) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Paint the grass floor for a world rect (pixel art, one texel per world px). */
  buildGround(rect) {
    const w = Math.ceil(rect.w), h = Math.ceil(rect.h);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    const img = g.createImageData(w, h);
    const hash = (a, b) => {
      let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
      x = Math.imul(x ^ (x >>> 13), 1274126177);
      return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
    };
    const pal = [[58, 84, 50], [63, 90, 54], [53, 78, 46], [68, 97, 57]];
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const sx = rect.x + px + 0.5, sy = rect.y + py + 0.5;
        const a = (sx - this.origin.x) / ISO.dx, b = (sy - this.origin.y) / ISO.dy;
        const col = (a + b) / 2, row = (b - a) / 2;
        const ci = Math.floor(col), ri = Math.floor(row);
        const base = pal[Math.floor(hash(ci, ri) * pal.length)];
        const n = hash(Math.floor(sx), Math.floor(sy));
        let [r, gg, bb] = base;
        if (n > 0.93) { r += 14; gg += 18; bb += 8; } // bright blades
        else if (n < 0.06) { r -= 10; gg -= 12; bb -= 8; } // dark specks
        const fc = col - ci, fr = row - ri;
        const edge = Math.min(fc, 1 - fc, fr, 1 - fr);
        if (edge < 0.035) { r -= 5; gg -= 6; bb -= 4; } // the faint lattice the tiles show
        if (hash(ci * 7 + 3, ri * 5 + 1) > 0.86 && hash(Math.floor(sx / 3), Math.floor(sy / 2)) > 0.72) { r += 30; gg += 22; bb += 4; } // dry tufts
        const i = (py * w + px) * 4;
        img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = bb; img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    if (this.groundTex) this.gl.deleteTexture(this.groundTex);
    this.groundTex = this.texture(cv);
    this.groundRect = { x: rect.x, y: rect.y, w, h };
  }

  /** A body: an image whose feet stand on world point (x, y). The feet are
   *  MEASURED (lowest opaque row, its centre) so any canvas size works. */
  async addSprite(url, name) {
    const img = await loadImage(url);
    const feet = measureFeet(img);
    const s = { name, img, tex: this.texture(img), w: img.width, h: img.height, feet, x: 0, y: 0, visible: true, top: feet.top };
    this.sprites.push(s);
    return s;
  }

  /** Draw one frame. view = world rect, vp = viewport in canvas px. */
  render(fx, opts) {
    const gl = this.gl;
    const { view, vp, night = false, pixel = true, clear = true } = opts;
    const scale = vp.w / view.w;
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vp.x, vp.y, vp.w, vp.h);
    if (clear) {
      gl.clearColor(0.08, 0.09, 0.1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    const V = viewMatrix(view.x, view.y, scale, vp.w, vp.h);
    blendPremultiplied(gl);
    const list = fx ? fx.drawList() : [];
    // lights: the effects' own, as the game's reserved slot would carry them
    const lights = fx ? fx.lights().slice(0, 4) : [];
    const amb = night ? NIGHT_AMBIENT : [1, 1, 1];
    const L = new Float32Array(16), Lc = new Float32Array(12);
    lights.forEach((l, i) => {
      const g = this.project(l.x, l.y);
      L.set([g.x, g.y - 0, l.radius * 45.25, 1], i * 4);
      const k = night ? 1 : 0.35;
      Lc.set([l.color[0] * k, l.color[1] * k, l.color[2] * k], i * 3);
    });
    const lightAt = (x, y) => {
      const out = [...amb];
      lights.forEach((l, i) => {
        const dx = x - L[i * 4], dy = (y - L[i * 4 + 1]) * 2.2857;
        const f = Math.max(0, 1 - Math.hypot(dx, dy) / L[i * 4 + 2]);
        out[0] += Lc[i * 3] * f * f; out[1] += Lc[i * 3 + 1] * f * f; out[2] += Lc[i * 3 + 2] * f * f;
      });
      return out;
    };
    // ground
    if (this.groundTex) this.drawSprite(this.groundTex, this.groundRect, V, amb, L, Lc, 0, true);
    // bodies + layers, painter's order
    const items = [];
    for (const d of list) items.push({ k: "fx", d, y: d.sortY, p: d.plane, o: d.order });
    for (const s of this.sprites) if (s.visible) items.push({ k: "sp", s, y: s.y, p: "body", o: 0.5 });
    const PO = { ground: 0, body: 1, air: 2, screen: 3 };
    items.sort((a, b) => PO[a.p] - PO[b.p] || a.y - b.y || a.o - b.o);
    for (const it of items) {
      if (it.k === "sp") {
        const s = it.s;
        const rect = { x: s.x - s.feet.x, y: s.y - s.feet.y, w: s.w, h: s.h };
        this.drawSprite(s.tex, rect, V, amb, L, Lc, s.y, false);
      } else {
        const d = it.d;
        if (!d.emissive) d.std.uTint = lightAt(d.ax, d.groundY);
        else delete d.std.uTint;
        this.fxgl.draw(d, V, pixel ? 0 : 0);
        blendPremultiplied(gl);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    return list.length;
  }

  drawSprite(tex, rect, V, amb, L, Lc, feetY, isGround) {
    const gl = this.gl, P = this.spriteProg;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(P.uTex, 0);
    gl.uniform4f(P.uRect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform4fv(P.uView, V);
    gl.uniform3fv(P.uAmb, amb);
    gl.uniform4fv(P.uL, L);
    gl.uniform3fv(P.uLc, Lc);
    gl.uniform1f(P.uFeetY, feetY);
    gl.uniform1f(P.uGround, isGround ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxgl.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

export function loadImage(url) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = () => rej(new Error(`image ${url}`));
    i.src = url;
  });
}

/** Lowest opaque row of an image and the centre of its pixels there. */
export function measureFeet(img) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let bottom = -1, top = -1;
  for (let y = c.height - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 128) { bottom = y; break; }
  for (let y = 0; y < c.height && top < 0; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 128) { top = y; break; }
  let x0 = c.width, x1 = 0;
  for (let y = Math.max(0, bottom - 4); y <= bottom; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  return { x: (x0 + x1 + 1) / 2, y: bottom + 1, top, height: bottom + 1 - top };
}

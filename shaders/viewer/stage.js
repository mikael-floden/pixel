// THE STAGE — a small piece of the game's world to judge an effect on, drawn
// the way the game draws it:
//  - the game's iso projection (32/14 px per cell step, 32 wu per cell);
//  - the real hero and monsters at the size the game draws them, pinned at
//    the game's foot anchor, playing their real clips (idle at the game's
//    6 fps; the cast clip started with the effect, so the spell leaves on its
//    key frame);
//  - the game's LIGHT (games2 WorldScene + nightlight.ts, ported verbatim):
//    ambient by time of day (TIME_PHASES / blendPhases), point lights with
//    att = (1 - d/r)^2 over cells, the height drop 0.6 per level, flicker and
//    ember rim, summed and capped at 1.25, MULTIPLIED into the world. Bodies
//    take the light at their feet (the game's lit-copy tint); a painted layer
//    the light at its ground point; an emissive layer is never darkened (the
//    game draws it above its darkness, at 900_001+). The reserved slots decide
//    WHICH lights: the hero's torch, one self-cast effect light, one monster
//    one (lightslots.ts) — a second fireball in flight lights nothing.
// Not modelled: terrain occlusion (the stage is flat), clouds, the sun's
// shadows, indoor grades.
//
// Rendering order is the painter's: ground, then ground-plane layers, then
// bodies and body-plane layers by the ground y they stand on, then air and
// screen layers.

import { FxGL, blendPremultiplied, viewMatrix } from "../runtime/gl.js";
import { toShaderLight } from "../runtime/phaser.js";

export const ISO = { dx: 32, dy: 14, cellWu: 32, levelPx: 15 };

/** WorldScene TIME_PHASES: what unlit art is multiplied by. Night is the
 *  calibrated reference. u = phase index + progress, 0..4. */
export const TIME_PHASES = [
  { name: "Night", ambient: [0.075, 0.09, 0.14] },
  { name: "Morning", ambient: [0.61, 0.43, 0.4] },
  { name: "Day", ambient: [1.0, 1.0, 1.0] },
  { name: "Evening", ambient: [0.74, 0.55, 0.37] },
];

/** WorldScene blendPhases, verbatim: linear between MID-phase anchors (at
 *  u = i + 0.5 the look is exactly phase i). torchF: 0 at full Day. */
export function blendPhases(u) {
  const N = TIME_PHASES.length;
  const v = u - 0.5;
  const k = Math.floor(v);
  const w = v - k;
  const i0 = ((k % N) + N) % N;
  const i1 = (i0 + 1) % N;
  const a0 = TIME_PHASES[i0].ambient, a1 = TIME_PHASES[i1].ambient;
  const L = (x, y) => x + (y - x) * w;
  return {
    ambient: [L(a0[0], a1[0]), L(a0[1], a1[1]), L(a0[2], a1[2])],
    torchF: L(i0 === 2 ? 0 : 1, i1 === 2 ? 0 : 1),
  };
}

/** The hero's own torch (WorldScene): waist-high, radius 6 cells. */
export const TORCH = { radius: 6, z: 0.55, color: [0.85, 0.58, 0.32], flicker: 0.35 };

const MAX_L = 4;
const LIGHT_DROP = 0.6; // nightlight.ts: levels of height count 0.6 of a cell
const CAP = 1.25; // nightlight.ts: min(light, vec3(1.25))

const SPRITE_VS = `precision highp float;
attribute vec2 aPos;
uniform vec4 uRect; uniform vec4 uView;
varying vec2 vUv; varying vec2 vW;
void main() {
  vec2 w = uRect.xy + aPos * uRect.zw;
  vUv = aPos; vW = w;
  gl_Position = vec4(w * uView.xy + uView.zw, 0.0, 1.0);
}`;
// the light function is nightlight.ts's per-light block with occlusion 1
const SPRITE_FS = `precision highp float;
uniform sampler2D uTex;
uniform vec3 uAmb;
uniform vec4 uL[${MAX_L}];
uniform vec4 uLc[${MAX_L}];
uniform float uT;
uniform vec2 uOrigin;
uniform vec3 uTint;
uniform float uGround;
varying vec2 vUv; varying vec2 vW;
vec3 lightAt(vec2 cell, float z) {
  vec3 L = uAmb;
  for (int i = 0; i < ${MAX_L}; i++) {
    if (uL[i].w <= 0.0) continue;
    vec2 d = cell - uL[i].xy;
    float dzl = (uL[i].z - z) * ${LIGHT_DROP.toFixed(2)};
    float dist = sqrt(dot(d, d) + dzl * dzl);
    float att = clamp(1.0 - dist / uL[i].w, 0.0, 1.0);
    att *= att;
    float fl = uLc[i].w, fi = float(i);
    float flick = 1.0 - fl * 0.10 * (0.5 + 0.5 * sin(uT * 2.9 + fi * 5.3)) - fl * 0.05 * sin(uT * 7.1 + fi * 11.1);
    float emb = smoothstep(0.35, 0.95, min(1.0, dist / uL[i].w)) * clamp(fl * 1.2, 0.0, 1.0);
    L += mix(uLc[i].rgb, uLc[i].rgb * vec3(0.95, 0.30, 0.12), emb) * att * flick;
  }
  return min(L, vec3(${CAP.toFixed(2)}));
}
void main() {
  vec4 c = texture2D(uTex, vUv);
  vec3 L = uTint;
  if (uGround > 0.5) {
    float a = (vW.x - uOrigin.x) / ${ISO.dx.toFixed(1)}, b = (vW.y - uOrigin.y) / ${ISO.dy.toFixed(1)};
    L = lightAt(vec2(a + b, b - a) * 0.5, 0.0);
  }
  gl_FragColor = vec4(c.rgb * L, c.a);
}`;

/** The same light on the CPU (a body's tint, a painted layer's). */
export function lightAtCell(col, row, z, amb, lights, t) {
  const out = [amb[0], amb[1], amb[2]];
  lights.forEach((l, i) => {
    if (!(l.radius > 0)) return;
    const dzl = (l.z - z) * LIGHT_DROP;
    const dist = Math.hypot(col - l.col, row - l.row, dzl);
    let att = Math.max(0, Math.min(1, 1 - dist / l.radius));
    att *= att;
    if (att <= 0.001) return;
    const fl = l.flicker || 0;
    const flick = 1 - fl * 0.1 * (0.5 + 0.5 * Math.sin(t * 2.9 + i * 5.3)) - fl * 0.05 * Math.sin(t * 7.1 + i * 11.1);
    const d01 = Math.min(1, dist / l.radius);
    const s = Math.max(0, Math.min(1, (d01 - 0.35) / 0.6));
    const emb = s * s * (3 - 2 * s) * Math.min(1, fl * 1.2);
    const eb = [0.95, 0.3, 0.12];
    for (let c = 0; c < 3; c++) out[c] += l.color[c] * (1 - emb + eb[c] * emb) * att * flick;
  });
  return out.map((v) => Math.min(CAP, v));
}

export class Stage {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: !!opts.preserve });
    if (!gl) throw new Error("WebGL is not available");
    this.gl = gl;
    this.fxgl = new FxGL(gl, { log: opts.log });
    this.origin = { x: 0, y: 0 }; // screen px of world (0, 0)
    this.bodies = [];
    this.textures = new Map(); // url -> Promise<{ tex, w, h, img }>
    this.groundTex = null;
    this.groundRect = null;
    this.spriteProg = this.makeSpriteProgram();
    this.lastLights = [];
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
    return {
      p, uRect: loc("uRect"), uView: loc("uView"), uTex: loc("uTex"), uAmb: loc("uAmb"), uL: loc("uL"), uLc: loc("uLc"),
      uT: loc("uT"), uOrigin: loc("uOrigin"), uTint: loc("uTint"), uGround: loc("uGround"),
    };
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

  /** One image as a texture, loaded once per url. */
  image(url) {
    let p = this.textures.get(url);
    if (!p) {
      p = loadImage(url).then((img) => ({ img, tex: this.texture(img), w: img.width, h: img.height }));
      this.textures.set(url, p);
      p.catch(() => this.textures.delete(url));
    }
    return p;
  }

  /** THE WIKI'S FLOOR PLAN (message shaders:ground): the ground's
   *  highest-weight base set, one member per cell already drawn by the
   *  members' weights — every choice the game makes is made by the wiki, the
   *  stage only paints it. Resolves once the tiles are loaded; a newer plan
   *  wins over one still loading. */
  async setGroundPlan(plan) {
    const ticket = (this.planTicket = (this.planTicket || 0) + 1);
    const tiles = await Promise.all(plan.tiles.map((t) => loadImage(t.url).then((img) => ({ img, apex: apexRow(img) }))));
    if (ticket !== this.planTicket) return false;
    this.groundPlan = { ...plan, tiles };
    if (this.groundRect) this.buildGround(this.groundRect);
    return true;
  }

  /** Paint the floor for a world rect (one texel per world px): the plan's
   *  tiles if there is one, else a procedural grass. */
  buildGround(rect) {
    if (this.groundPlan) return this.paintPlan(rect);
    return this.paintGrass(rect);
  }

  /** Tiles3 art on the game's lattice: a plate's top diamond is 64x28 with
   *  its apex on the image's top opaque row (a 64x46 plate: row 0, and 18
   *  rows of wall below that the next row's tiles cover); the apex of cell
   *  (c, r) is the projection of its corner (c, r). Painter's order by c + r. */
  paintPlan(rect) {
    const w = Math.ceil(rect.w), h = Math.ceil(rect.h);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    const P = this.groundPlan, { cols, rows, cells } = P.grid;
    const corners = [[rect.x, rect.y], [rect.x + w, rect.y], [rect.x, rect.y + h], [rect.x + w, rect.y + h]].map(([x, y]) => this.unproject(x, y));
    const cs = corners.map((q) => q.x / ISO.cellWu), rs = corners.map((q) => q.y / ISO.cellWu);
    const c0 = Math.floor(Math.min(...cs)) - 2, c1 = Math.ceil(Math.max(...cs)) + 2;
    const r0 = Math.floor(Math.min(...rs)) - 2, r1 = Math.ceil(Math.max(...rs)) + 2;
    const list = [];
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) list.push([c, r]);
    list.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[1] - b[1]);
    const mod = (v, n) => ((v % n) + n) % n;
    for (const [c, r] of list) {
      const t = P.tiles[cells[mod(r, rows) * cols + mod(c, cols)]];
      if (!t) continue;
      const ax = this.origin.x + (c - r) * ISO.dx - rect.x, ay = this.origin.y + (c + r) * ISO.dy - rect.y;
      if (ax < -ISO.dx * 2 || ax > w + ISO.dx * 2 || ay < -t.img.height || ay > h + ISO.dy * 2) continue;
      g.drawImage(t.img, Math.round(ax - t.img.width / 2), Math.round(ay - t.apex));
    }
    if (this.groundTex) this.gl.deleteTexture(this.groundTex);
    this.groundTex = this.texture(cv);
    this.groundRect = { x: rect.x, y: rect.y, w, h };
  }

  paintGrass(rect) {
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

  /** A body on the stage: its feet at screen (x, y); `frame` = the texture to
   *  draw ({ tex, w, h }) and `anchor` = the feet inside it (frame px). */
  addBody(name) {
    const b = { name, x: 0, y: 0, visible: false, frame: null, anchor: { x: 0, y: 0 } };
    this.bodies.push(b);
    return b;
  }

  /** The lights of this frame, as the game's slots would carry them:
   *  [torch?, selfFx?, monsterFx?] -> nightlight ShaderLights (cells, levels). */
  slotLights(fx, torch) {
    const out = [];
    if (torch) out.push(torch);
    if (fx) {
      const self = fx.lights((l) => l.owner !== "monster")[0];
      const mon = fx.lights((l) => l.owner === "monster")[0];
      for (const l of [self, mon]) if (l) out.push(toShaderLight(l, { cellWu: ISO.cellWu, levelPx: ISO.levelPx }));
    }
    return out.slice(0, MAX_L);
  }

  /** Draw one frame. view = world rect, vp = viewport in canvas px, u = time
   *  of day (0..4), torch = the hero's torch as a ShaderLight or null. */
  render(fx, opts) {
    const gl = this.gl;
    const { view, vp, u = 0.5, torch = null, clear = true, t = performance.now() / 1000 } = opts;
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
    const amb = blendPhases(u).ambient;
    const lights = this.slotLights(fx, torch);
    this.lastLights = lights;
    const L = new Float32Array(4 * MAX_L), Lc = new Float32Array(4 * MAX_L);
    lights.forEach((l, i) => {
      L.set([l.col, l.row, l.z, l.radius], i * 4);
      Lc.set([l.color[0], l.color[1], l.color[2], l.flicker || 0], i * 4);
    });
    const cellOf = (sx, sy) => {
      const w = this.unproject(sx, sy);
      return [w.x / ISO.cellWu, w.y / ISO.cellWu];
    };
    const tintAt = (sx, sy) => {
      const [c, r] = cellOf(sx, sy);
      return lightAtCell(c, r, 0, amb, lights, t);
    };
    const U = { V, amb, L, Lc, t };
    // ground
    if (this.groundTex) this.drawSprite(this.groundTex, this.groundRect, U, [1, 1, 1], true);
    // bodies + layers, painter's order
    const items = [];
    for (const d of list) items.push({ k: "fx", d, y: d.sortY, p: d.plane, o: d.order });
    for (const b of this.bodies) if (b.visible && b.frame) items.push({ k: "b", b, y: b.y, p: "body", o: 0.5 });
    const PO = { ground: 0, body: 1, air: 2, screen: 3 };
    items.sort((a, b) => PO[a.p] - PO[b.p] || a.y - b.y || a.o - b.o);
    for (const it of items) {
      if (it.k === "b") {
        const b = it.b, f = b.frame;
        const rect = { x: Math.round(b.x - b.anchor.x), y: Math.round(b.y - b.anchor.y), w: f.w, h: f.h };
        this.drawSprite(f.tex, rect, U, tintAt(b.x, b.y), false);
      } else {
        const d = it.d;
        if (!d.emissive) d.std.uTint = tintAt(d.ax, d.groundY);
        else delete d.std.uTint;
        this.fxgl.draw(d, V, 0);
        blendPremultiplied(gl);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    return list.length;
  }

  drawSprite(tex, rect, U, tint, isGround) {
    const gl = this.gl, P = this.spriteProg;
    gl.useProgram(P.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(P.uTex, 0);
    gl.uniform4f(P.uRect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform4fv(P.uView, U.V);
    gl.uniform3fv(P.uAmb, U.amb);
    gl.uniform4fv(P.uL, U.L);
    gl.uniform4fv(P.uLc, U.Lc);
    gl.uniform1f(P.uT, U.t);
    gl.uniform2f(P.uOrigin, this.origin.x, this.origin.y);
    gl.uniform3fv(P.uTint, tint);
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

/** The first row with any opaque pixel: a tile's diamond apex. */
function apexRow(img) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 64) return y;
  return 0;
}

/** Lowest opaque row of an image and the centre of its pixels there — the
 *  feet of a monster frame (heroes use the game's measured anchor). */
export function measureFeet(img) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let bottom = -1, top = -1;
  for (let y = c.height - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 128) { bottom = y; break; }
  for (let y = 0; y < c.height && top < 0; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 128) { top = y; break; }
  let x0 = c.width, x1 = 0, w0 = c.width, w1 = 0;
  for (let y = Math.max(0, bottom - 4); y <= bottom; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  for (let y = Math.max(0, top); y <= bottom; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 128) { w0 = Math.min(w0, x); w1 = Math.max(w1, x); }
  return { x: (x0 + x1 + 1) / 2, y: bottom + 1, top, height: bottom + 1 - top, width: w1 + 1 - w0 };
}

// THE PHASER ADAPTER (Phaser 3.90, the game's version; WebGL renderer only).
//
//   import { createPhaserFx, nangijalaDepth } from "<repo>/effects/runtime/phaser.js";
//   import LIBRARY from "<repo>/effects/library/index.js";
//   const fx = createPhaserFx(scene, {
//     project: (x, y) => worldScene.project(x, y),   // world units -> Phaser world px of that ground point
//     depth: (d) => ...,                              // optional: the game's own depth rule (default nangijalaDepth)
//     library: LIBRARY,
//   });
//   fx.play("fire/fireball", { level, from: caster, to: () => target, height, targetHeight, owner: "self" });
//
// HOW IT DRAWS, and why (his phone is a tile-based Mali, fill-rate bound):
//  1. On the scene's POSTUPDATE — after the game moved its bodies, BEFORE the
//     camera renders — every live layer is rendered into its own small texture
//     at WORLD resolution (one texel per world px). All of it happens before the
//     frame's main framebuffer is touched: no mid-frame framebuffer switch, and a
//     layer costs one fragment per WORLD pixel instead of one per device pixel
//     (9x fewer at his zoom 3). It is also what makes an effect pixel-true: its
//     pixels are the art's pixels, scaled nearest-neighbour like every sprite.
//  2. Each layer is then an ordinary Phaser Image (NORMAL blend = premultiplied
//     over, which is exactly what every layer outputs) at the layer's box, with
//     a depth from `depth(d)` — so effects sort with bodies through the game's
//     own depth rule and cost the sprite batch nothing special.
//
// GL hygiene: the pre-pass runs between PipelineManager.clear() and rebind(),
// through the renderer's own push/popFramebuffer, and restores the scissor
// test it found. It binds no texture unit.

import { FxWorld } from "./fx.js";
import { FxGL, viewMatrix } from "./gl.js";

const NEAREST = 1; // Phaser.ScaleModes.NEAREST
const MAX = 1024;
const pow2 = (v) => Math.min(MAX, Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, v)))));

/** Today's games2 depth bands (WorldScene.ts): the darkness overlay sits at
 *  900_000, lit copies at litDepth(base) = 900_001 + base * 1e-5, the monster
 *  rings at 900_001.43-.45, damage floats at 900_002. Bodies sort by the screen
 *  y of their feet. An EMISSIVE layer lives in the lit band (night never dims
 *  it); a painted one lives with the bodies (night dims it like the world). The
 *  game agent may replace this with its real rule (resolveDrawDepth). */
export function nangijalaDepth(d) {
  const base = d.plane === "ground" ? d.sortY - 0.5 : d.sortY + 0.25;
  switch (d.plane) {
    case "screen": return 900_004;
    case "air": return 900_003 + d.order * 1e-9;
    default: return d.emissive ? 900_001 + base * 1e-5 : base;
  }
}

/** A plain rule for any other Phaser scene: planes in order, then feet y. */
export function simpleDepth(d) {
  const P = { ground: 0, body: 1, air: 2, screen: 3 }[d.plane];
  return P * 1e6 + (d.plane === "ground" || d.plane === "body" ? d.sortY : 0) + d.order * 1e-6;
}

export function createPhaserFx(scene, opts = {}) {
  return new PhaserFx(scene, opts);
}

export class PhaserFx {
  constructor(scene, opts) {
    this.scene = scene;
    this.renderer = scene.sys.renderer;
    this.enabled = !!(this.renderer && this.renderer.gl);
    const cam = () => scene.cameras.main;
    this.world = new FxWorld(
      {
        project: opts.project,
        cellWu: opts.cellWu,
        basis: opts.basis,
        view: () => {
          const v = cam().worldView;
          return { x: v.x, y: v.y, w: v.width, h: v.height };
        },
      },
      { style: opts.style, log: opts.log },
    );
    if (opts.library) this.world.registerAll(opts.library);
    this.depth = opts.depth || nangijalaDepth;
    this.live = new Map(); // layer key -> slot, this frame's
    this.pool = []; // free slots, textures kept
    this.list = [];
    this.uid = PhaserFx.uid = (PhaserFx.uid || 0) + 1;
    this.stats = { layers: 0, texels: 0, reallocs: 0 };
    if (this.enabled) {
      this.fxgl = new FxGL(this.renderer.gl, { log: opts.log });
      this.onRestore = () => {
        this.fxgl.restore();
        this.destroySlots();
      };
      this.renderer.on("restorewebgl", this.onRestore);
    }
    if (opts.autoUpdate !== false) {
      this.onPost = (_t, dtMs) => this.tick(dtMs / 1000);
      scene.events.on("postupdate", this.onPost);
    }
    scene.events.once("shutdown", () => this.destroy());
  }

  // ---- the FxWorld API, passed through ----
  play(id, p) { return this.world.play(id, p); }
  register(d) { this.world.register(d); return this; }
  registerAll(ds) { this.world.registerAll(ds); return this; }
  setTuning(t) { this.world.setTuning(t); return this; }
  setStyle(s) { this.world.setStyle(s); return this; }
  lights(f) { return this.world.lights(f); }
  clear() { this.world.clear(); this.render(); }
  get count() { return this.world.count; }
  /** Compile every layer now, so the first cast of a spell never hitches. */
  warm(ids) {
    if (!this.enabled) return;
    for (const id of ids || this.world.defs.keys()) {
      const d = this.world.defs.get(id);
      if (d) this.fxgl.warm(d);
    }
    this.renderer.pipelines.rebind();
  }

  /** Advance and draw. Called on postupdate unless autoUpdate was false. */
  tick(dt) {
    this.world.update(dt);
    this.render();
  }

  // ---- texture slots: one per live layer, kept across frames ----
  // A layer keeps its slot for its whole life (keyed by instance + layer), so
  // a growing blast re-allocates at most a few times (power-of-two sizes)
  // instead of every frame; a freed slot goes back to a small pool.
  // The FRAMEBUFFER is a raw one of ours around the Phaser-owned texture:
  // Phaser 3.90's WebGLFramebufferWrapper.destroy() queries an attachment that
  // does not exist and raises INVALID_ENUM on WebGL1 (measured in phaser-check).
  alloc(w, h, s) {
    const r = this.renderer, gl = r.gl;
    const W = pow2(w), H = pow2(h);
    if (s) this.freeGL(s);
    const key = `__nfx${this.uid}_${this.keySeq = (this.keySeq || 0) + 1}`;
    const tex = r.createTextureFromSource(null, W, H, NEAREST, true);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.webGLTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.scene.textures.addGLTexture(key, tex);
    let image = s && s.image;
    if (!image) image = this.scene.add.image(0, 0, key).setOrigin(0, 0);
    else image.setTexture(key);
    image.setVisible(false);
    this.stats.reallocs++;
    return Object.assign(s || {}, { W, H, key, tex, fb, image });
  }

  freeGL(s) {
    if (s.fb) this.renderer.gl.deleteFramebuffer(s.fb);
    if (this.scene.textures.exists(s.key)) this.scene.textures.remove(s.key);
    s.fb = null;
  }

  slotFor(key, w, h) {
    let s = this.live.get(key);
    if (!s) {
      let best = -1;
      for (let i = 0; i < this.pool.length; i++) if (this.pool[i].W >= w && this.pool[i].H >= h && (best < 0 || this.pool[i].W * this.pool[i].H < this.pool[best].W * this.pool[best].H)) best = i;
      s = best >= 0 ? this.pool.splice(best, 1)[0] : this.pool.pop();
      if (!s) s = this.alloc(w, h, null);
      this.live.set(key, s);
    }
    if (w > s.W || h > s.H) this.alloc(Math.max(w, s.W), Math.max(h, s.H), s);
    s.used = this.frame;
    return s;
  }

  destroySlots() {
    for (const s of [...this.live.values(), ...this.pool]) {
      this.freeGL(s);
      if (s.image) s.image.destroy();
    }
    this.live = new Map();
    this.pool = [];
  }

  render() {
    const list = this.world.drawList(this.list);
    this.stats.layers = list.length;
    if (!this.enabled) return;
    const r = this.renderer, gl = r.gl;
    this.frame = (this.frame || 0) + 1;
    if (!this.live) { this.live = new Map(); this.pool = []; }
    const slots = list.map((d) => this.slotFor(`${d.handle.seq}#${d.layer}#${d.order}`, d.w, d.h));
    for (const [k, s] of this.live) {
      if (s.used === this.frame) continue;
      this.live.delete(k);
      s.image.setVisible(false);
      if (this.pool.length < 24) this.pool.push(s);
      else { this.freeGL(s); s.image.destroy(); }
    }
    if (!list.length) return;
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    const prevFb = r.currentFramebuffer;
    r.pipelines.clear();
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    let texels = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i], s = slots[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
      gl.viewport(0, 0, s.W, s.H);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(0, 0, d.w, d.h);
      // flipY: row 0 of the texture is the TOP of the box, Phaser's convention
      this.fxgl.draw(d, viewMatrix(d.x, d.y, 1, d.w, d.h, true), 0);
      texels += d.w * d.h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb ? prevFb.webGLFramebuffer : null);
    gl.disableVertexAttribArray(0);
    r.pipelines.rebind();
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    this.stats.texels = texels;
    for (let i = 0; i < list.length; i++) {
      const d = list[i], img = slots[i].image;
      img.setCrop(0, 0, d.w, d.h);
      img.setPosition(d.x, d.y);
      img.setDepth(this.depth(d));
      img.setVisible(true);
    }
  }

  destroy() {
    if (this.onPost) this.scene.events.off("postupdate", this.onPost);
    if (this.onRestore) this.renderer.off("restorewebgl", this.onRestore);
    this.world.clear();
    if (this.enabled) this.destroySlots();
  }
}

/** A light from fx.lights() as games2's ShaderLight (col/row/z in LEVELS,
 *  radius in cells). levelAt(x, y) is the ground's level under a world point;
 *  levelPx the storey pitch (tiles3: 15). */
export function toShaderLight(l, { cellWu = 32, levelPx = 15, levelAt = () => 0 } = {}) {
  return {
    col: l.x / cellWu,
    row: l.y / cellWu,
    z: levelAt(l.x, l.y) + l.z / levelPx,
    radius: l.radius,
    color: l.color,
    flicker: l.flicker,
  };
}

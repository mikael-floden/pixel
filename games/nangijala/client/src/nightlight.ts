import Phaser from "phaser";
import { ISO_DX, ISO_DY, surfaceFor } from "@nangijala/shared";
import { World, MAP_GEOMETRY } from "./maps";

/**
 * Serious night lighting: a fullscreen MULTIPLY shader that reconstructs each
 * pixel's WORLD position (cell + height) from the tile geometry, then for every
 * point light computes distance attenuation (in cell units ≈ meters) and
 * LINE-OF-SIGHT by raymarching the world heightmap — walls cast real shadows.
 * Several lights blend; fire-type lights flicker. The scene is multiplied by
 * ambient + Σ light contributions, so unlit areas sink into the night grade
 * and lit areas keep their true colours.
 *
 * Pixel → world reconstruction: for candidate level L (top→down), invert
 *   y = oy + (col+row)·dy − L·lh,  x = ox + (col−row)·dx
 * and accept the highest L whose heightmap cell is at least that tall (side
 * faces resolve to the wall's cell at the assumed height).
 */

export interface ShaderLight {
  col: number; // grid coords (fractional ok)
  row: number;
  z: number; // height in levels
  radius: number; // in cells
  color: [number, number, number];
  flicker: number; // 0 = steady, 1 = full fire flicker
}

export const MAX_SHADER_LIGHTS = 6;

const FRAG = `
precision highp float;

uniform vec2 resolution;
uniform float time;
uniform vec4 uCam;        // worldView x, y, w, h (world-render px)
uniform vec4 uIsoA;       // ox, oy, dx, dy
uniform vec4 uIsoB;       // lh, gridW, gridH, maxLevel
uniform vec3 uAmbient;    // night grade (what unlit white becomes)
uniform float uNumLights;
uniform vec4 uLightPos[${MAX_SHADER_LIGHTS}];  // col, row, z, radius(cells)
uniform vec4 uLightCol[${MAX_SHADER_LIGHTS}];  // r, g, b, flicker
uniform sampler2D uHeight;

float heightAt(vec2 cr) {
  if (cr.x < 0.0 || cr.y < 0.0 || cr.x >= uIsoB.y || cr.y >= uIsoB.z) return 99.0;
  vec2 uv = (floor(cr) + 0.5) / vec2(uIsoB.y, uIsoB.z);
  return texture2D(uHeight, uv).r * 255.0 / 16.0;
}

void main() {
  vec2 suv = gl_FragCoord.xy / resolution;
  float wx = uCam.x + suv.x * uCam.z;
  // Rendered into a texture that Phaser composites y-flipped — sample top-down.
  float wy = uCam.y + suv.y * uCam.w;
  float u = (wx - uIsoA.x) / uIsoA.z;
  float v0 = (wy - uIsoA.y) / uIsoA.w; // grid diagonal at height 0
  float kk = uIsoB.x / uIsoA.w;        // diagonal shift per height level

  // Resolve the surface this pixel shows. A point at height h projects onto
  // diagonal v = v0 + h*kk, so this pixel's candidates lie on a ray through
  // (v, h) space; walking it front-to-back the ray crosses ONE grid cell per
  // unit of v. For each cell the hit height is solved EXACTLY (the column's
  // top, or the ray's own height on that segment = a wall-face pixel), so
  // faces get precise fractional heights — fixed-step marching aliased into
  // sawtooth teeth on tall walls.
  float vTop = v0 + uIsoB.w * kk;
  float z = 0.0;
  vec2 cell = vec2(0.0);
  bool found = false;
  // Walk the ray over EXACT cell-boundary crossings (col crosses integers at
  // v = 2m - u, row at v = 2n + u) so every interval lies inside exactly one
  // cell. Fixed-width segments straddled cells, attributing wall pixels to
  // the wrong column — every face rule downstream then judged the wrong wall.
  float vHi = vTop;
  for (int s = 0; s < 36; s++) {
    if (found || vHi <= v0 - 1.5) continue;
    float vColB = 2.0 * floor((vHi + u) * 0.5 - 0.0001) - u;
    float vRowB = 2.0 * floor((vHi - u) * 0.5 - 0.0001) + u;
    float vLo = max(vColB, vRowB);
    float vMid = (vHi + vLo) * 0.5;
    vec2 cr = vec2((u + vMid) * 0.5, (vMid - u) * 0.5);
    float H = heightAt(cr);
    if (H < 90.0) {
      float vSurf = v0 + H * kk; // this column's top along the ray
      if (vSurf >= vLo - 0.0001) {
        float vHit = min(vHi, vSurf);
        z = max((vHit - v0) / kk, 0.0);
        cell = cr;
        found = true;
      }
    }
    vHi = vLo;
  }
  if (!found) {
    // Off-map / unresolved: plain ambient.
    gl_FragColor = vec4(uAmbient, 1.0);
    return;
  }

  vec3 light = uAmbient;
  for (int i = 0; i < ${MAX_SHADER_LIGHTS}; i++) {
    if (float(i) >= uNumLights) continue;
    vec3 lp = uLightPos[i].xyz;
    float radius = uLightPos[i].w;
    vec2 d2 = lp.xy - cell;
    float dist = sqrt(dot(d2, d2) + pow((lp.z - z) * 0.6, 2.0));
    float att = clamp(1.0 - dist / radius, 0.0, 1.0);
    att *= att;
    if (att <= 0.001) continue;

    // Line of sight: march the heightmap toward the light. Occlusion scales
    // with HOW FAR the blocker pokes above the ray — grazing edges dim gently
    // instead of stamping hard cell-shaped shadow blocks. Only samples in the
    // pixel's OWN column are skipped (a wall must not shadow its own face,
    // but it MUST still block light for the ground right at its base).
    // Surfaces ABOVE the light skip the LOS shadow and fade by distance only:
    // characters are billboards, and a body's upper pixels sample the terrain
    // BEHIND them — if a higher backdrop rim-shadows itself against a low
    // torch, the character standing lit in front turns black with it. Light
    // received from above or level (cliff bases, object shadows, faces)
    // keeps full occlusion.
    float occ = 1.0;
    if (z < lp.z + 0.05) {
      for (int s = 1; s <= 12; s++) {
        float t = float(s) / 13.0;
        vec2 p = mix(cell, lp.xy, t);
        if (floor(p.x) == floor(cell.x) && floor(p.y) == floor(cell.y)) continue;
        float hRay = mix(z, lp.z, t) + 0.2;
        float H = heightAt(p);
        if (H < 90.0 && H > hRay) occ *= mix(0.8, 0.45, clamp((H - hRay) * 1.5, 0.0, 1.0));
      }
    }

    // Side-face pixels (below their column's top): a column shows TWO faces —
    // left of its front corner faces +row, right of it faces +col. Each face
    // only catches light that stands beyond ITS OWN plane (in cells), so a
    // torch on the right lights the right face but never wraps onto the
    // left one, and a torch on top (behind both planes) lights neither.
    float Hown = heightAt(cell);
    if (Hown < 90.0 && Hown - z > 0.05) {
      vec2 base = floor(cell);
      float frontL = lp.y - (base.y + 1.0); // beyond the +row (left) face
      float frontR = lp.x - (base.x + 1.0); // beyond the +col (right) face
      float uf = u - (base.x - base.y);     // pixel left/right of front corner
      float pickR = smoothstep(-0.2, 0.2, uf);
      // On a CONTINUOUS wall the resolve can own a band as either of two
      // same-height cells; a face is only exposed where its neighbour is
      // lower than the pixel. If the nominal face is buried, the visible
      // surface is the neighbour's PERPENDICULAR face — gate on that plane.
      float hR = heightAt(base + vec2(1.5, 0.5));
      float hD = heightAt(base + vec2(0.5, 1.5));
      if (hR < 90.0 && hR > z + 0.01) pickR = 0.0; // +col face buried
      if (hD < 90.0 && hD > z + 0.01) pickR = 1.0; // +row face buried
      float front = mix(frontL, frontR, pickR);
      // Lambert: `front` IS the normal component of the light offset, so
      // front/|d2| is cos(angle off the face normal). A light sliding along
      // the wall (grazing) must not light it — only lights meaningfully IN
      // FRONT of the face do.
      float cosF = front / max(length(d2), 0.001);
      occ *= smoothstep(0.5, 0.85, cosF);
    }

    // Fire flicker: slow cozy breathing + a mild shimmer (fast large-swing
    // flicker reads as a strobe when it drives a whole light pool).
    float fl = uLightCol[i].w;
    float flick = 1.0
      - fl * 0.10 * (0.5 + 0.5 * sin(time * 2.9 + float(i) * 5.3))
      - fl * 0.05 * sin(time * 7.1 + float(i) * 11.1);

    // Fire cools at the rim: fire-type lights (flicker > 0) shift from their
    // hot core colour toward deep ember red as they attenuate, so the pool
    // ends in a warm red ring instead of dimming uniformly.
    vec3 lc = uLightCol[i].rgb;
    vec3 ember = lc * vec3(0.95, 0.30, 0.12);
    float d01 = clamp(dist / radius, 0.0, 1.0);
    vec3 col = mix(lc, ember, smoothstep(0.35, 0.95, d01) * clamp(fl * 1.2, 0.0, 1.0));

    light += col * att * occ * flick;
  }

  gl_FragColor = vec4(min(light, vec3(1.25)), 1.0);
}
`;

const FIELD_KEY = "night-light-field";

export class NightLights {
  private scene: Phaser.Scene;
  private world: World;
  private iso: { ox: number; oy: number };
  private maxLevel: number;
  private base?: Phaser.Display.BaseShader;
  private shader?: Phaser.GameObjects.Shader;
  private overlay?: Phaser.GameObjects.Image;
  private posArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private colArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private fieldCount = 0;
  active = false;

  constructor(scene: Phaser.Scene, world: World, iso: { ox: number; oy: number }, maxLevel: number) {
    this.scene = scene;
    this.world = world;
    this.iso = iso;
    this.maxLevel = maxLevel;
  }

  create() {
    this.buildHeightmap();
    this.base = new Phaser.Display.BaseShader("night-lights", FRAG, undefined, {
      uCam: { type: "4f", value: { x: 0, y: 0, z: 1, w: 1 } },
      uIsoA: { type: "4f", value: { x: 0, y: 0, z: ISO_DX, w: ISO_DY } },
      uIsoB: { type: "4f", value: { x: MAP_GEOMETRY.lh, y: 1, z: 1, w: 0 } },
      uAmbient: { type: "3f", value: { x: 0.16, y: 0.2, z: 0.36 } },
      uNumLights: { type: "1f", value: 0 },
      uLightPos: { type: "4fv", value: this.posArr },
      uLightCol: { type: "4fv", value: this.colArr },
      uHeight: { type: "sampler2D", value: null },
    });
    // Shader GameObjects can't blend directly — render the light field to a
    // texture and composite it with a MULTIPLY image on top of the scene.
    this.overlay = this.scene.add
      .image(0, 0, "__WHITE")
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(900_000)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false);
    this.buildShader(this.scene.scale.width, this.scene.scale.height);
    // The render target does NOT follow setSize — a resized window left a
    // stale wrong-scale light field (bright rectangles, pools that ignore
    // zoom). Rebuild the shader + target at the new size instead.
    this.scene.scale.on("resize", (sz: Phaser.Structs.Size) => {
      this.buildShader(sz.width, sz.height);
    });
  }

  /** (Re)create the shader + its render target at the given size. */
  private buildShader(width: number, height: number) {
    if (!this.base || width <= 0 || height <= 0) return;
    this.shader?.destroy();
    // A fresh texture key per size: destroying a shader doesn't unregister
    // its render target, and re-binding an existing key throws.
    const key = `${FIELD_KEY}-${this.fieldCount++}`;
    const s = this.scene.add
      .shader(this.base, 0, 0, width, height)
      .setOrigin(0, 0)
      .setVisible(this.active);
    s.setSampler2D("uHeight", "world-heightmap");
    s.setRenderToTexture(key);
    this.shader = s;
    const old = this.overlay!.texture.key;
    this.overlay!.setTexture(key).setDisplaySize(width, height);
    if (old.startsWith(FIELD_KEY) && this.scene.textures.exists(old)) {
      this.scene.textures.remove(old);
    }
  }

  /** Grid heightmap texture: R = level*16 (levels 0..9 → 0..144). Solid
   * structures (trees, boulders…) count one level above their ground, same
   * as the occlusion renderer — they must block light, not just players. */
  private buildHeightmap() {
    if (this.scene.textures.exists("world-heightmap")) return;
    const w = this.world.width;
    const h = this.world.height;
    const tex = this.scene.textures.createCanvas("world-heightmap", w, h);
    const ctx = tex!.getContext();
    const img = ctx.createImageData(w, h);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = (r * w + c) * 4;
        const cell = this.world.rows[r][c];
        const s = surfaceFor(cell.t);
        const lvl = cell.l + (s.standable || s.swimmable ? 0 : 1);
        img.data[i] = Math.min(255, lvl * 16);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    tex!.refresh();
  }

  setActive(on: boolean) {
    this.active = on;
    this.shader?.setVisible(on);
    this.overlay?.setVisible(on);
  }

  update(cam: Phaser.Cameras.Scene2D.Camera, lights: ShaderLight[], ambient: [number, number, number]) {
    if (!this.shader || !this.active) return;
    const s = this.shader;
    s.setUniform("uCam.value.x", cam.worldView.x);
    s.setUniform("uCam.value.y", cam.worldView.y);
    s.setUniform("uCam.value.z", cam.worldView.width);
    s.setUniform("uCam.value.w", cam.worldView.height);
    s.setUniform("uIsoA.value.x", this.iso.ox);
    s.setUniform("uIsoA.value.y", this.iso.oy);
    s.setUniform("uIsoB.value.y", this.world.width);
    s.setUniform("uIsoB.value.z", this.world.height);
    s.setUniform("uIsoB.value.w", this.maxLevel);
    s.setUniform("uAmbient.value.x", ambient[0]);
    s.setUniform("uAmbient.value.y", ambient[1]);
    s.setUniform("uAmbient.value.z", ambient[2]);
    const n = Math.min(lights.length, MAX_SHADER_LIGHTS);
    for (let i = 0; i < n; i++) {
      const l = lights[i];
      this.posArr[i * 4] = l.col;
      this.posArr[i * 4 + 1] = l.row;
      this.posArr[i * 4 + 2] = l.z;
      this.posArr[i * 4 + 3] = l.radius;
      this.colArr[i * 4] = l.color[0];
      this.colArr[i * 4 + 1] = l.color[1];
      this.colArr[i * 4 + 2] = l.color[2];
      this.colArr[i * 4 + 3] = l.flicker;
    }
    s.setUniform("uNumLights.value", n);
    s.setUniform("uLightPos.value", this.posArr);
    s.setUniform("uLightCol.value", this.colArr);
  }
}

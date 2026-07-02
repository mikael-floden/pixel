import Phaser from "phaser";
import { ISO_DX, ISO_DY } from "@nangijala/shared";
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
  float wy = uCam.y + (1.0 - suv.y) * uCam.w;
  float u = (wx - uIsoA.x) / uIsoA.z;

  // Resolve which surface (cell + height) this pixel shows: highest level
  // whose cell is at least that tall.
  float z = 0.0;
  vec2 cell = vec2(0.0);
  bool found = false;
  for (int L = 12; L >= 0; L--) {
    if (found || float(L) > uIsoB.w) continue;
    float v = (wy - uIsoA.y + float(L) * uIsoB.x) / uIsoA.w;
    vec2 cr = vec2((u + v) * 0.5, (v - u) * 0.5);
    float H = heightAt(cr);
    if (H < 90.0 && H >= float(L) - 0.01) {
      z = float(L);
      cell = cr;
      found = true;
    }
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

    // Line of sight: march the heightmap toward the light; terrain above the
    // ray softly shadows (each blocking sample dims, not a hard cutoff).
    float occ = 1.0;
    for (int s = 1; s <= 8; s++) {
      float t = float(s) / 9.0;
      vec2 p = mix(cell, lp.xy, t);
      float hRay = mix(z, lp.z, t) + 0.3;
      float H = heightAt(p);
      if (H < 90.0 && H > hRay) occ *= 0.5;
    }

    // Fire flicker: two unsynced sines + a fast shimmer.
    float fl = uLightCol[i].w;
    float flick = 1.0
      - fl * 0.22 * (0.5 + 0.5 * sin(time * 8.7 + float(i) * 5.3))
      - fl * 0.10 * sin(time * 21.0 + float(i) * 11.1);

    light += uLightCol[i].rgb * att * occ * flick;
  }

  gl_FragColor = vec4(min(light, vec3(1.25)), 1.0);
}
`;

export class NightLights {
  private scene: Phaser.Scene;
  private world: World;
  private iso: { ox: number; oy: number };
  private maxLevel: number;
  private shader?: Phaser.GameObjects.Shader;
  private overlay?: Phaser.GameObjects.Image;
  private posArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  private colArr = new Float32Array(MAX_SHADER_LIGHTS * 4);
  active = false;

  constructor(scene: Phaser.Scene, world: World, iso: { ox: number; oy: number }, maxLevel: number) {
    this.scene = scene;
    this.world = world;
    this.iso = iso;
    this.maxLevel = maxLevel;
  }

  create() {
    this.buildHeightmap();
    const base = new Phaser.Display.BaseShader("night-lights", FRAG, undefined, {
      uCam: { type: "4f", value: { x: 0, y: 0, z: 1, w: 1 } },
      uIsoA: { type: "4f", value: { x: 0, y: 0, z: ISO_DX, w: ISO_DY } },
      uIsoB: { type: "4f", value: { x: MAP_GEOMETRY.lh, y: 1, z: 1, w: 0 } },
      uAmbient: { type: "3f", value: { x: 0.16, y: 0.2, z: 0.36 } },
      uNumLights: { type: "1f", value: 0 },
      uLightPos: { type: "4fv", value: this.posArr },
      uLightCol: { type: "4fv", value: this.colArr },
    });
    // Shader GameObjects can't blend directly — render the light field to a
    // texture and composite it with a MULTIPLY image on top of the scene.
    const s = this.scene.add
      .shader(base, 0, 0, this.scene.scale.width, this.scene.scale.height)
      .setOrigin(0, 0)
      .setVisible(false);
    s.setSampler2D("uHeight", "world-heightmap");
    s.setRenderToTexture("night-light-field");
    this.overlay = this.scene.add
      .image(0, 0, "night-light-field")
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(900_000)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setVisible(false);
    this.shader = s;
    this.scene.scale.on("resize", (sz: Phaser.Structs.Size) => {
      s.setSize(sz.width, sz.height);
      this.overlay?.setDisplaySize(sz.width, sz.height);
    });
  }

  /** Grid heightmap texture: R = level*16 (levels 0..9 → 0..144). */
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
        img.data[i] = Math.min(255, this.world.rows[r][c].l * 16);
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

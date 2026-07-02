import Phaser from "phaser";
import { ISO_DX, ISO_DY } from "@nangijala/shared";

/**
 * Atmosphere layer: a screen-space darkness overlay that light sources punch
 * soft pools through, warm additive glows on each light, and a vignette.
 * Fallback night lighting for canvas renderers — when WebGL is available the
 * per-pixel shader (nightlight.ts) owns the screen and this grade stands down.
 *
 * Technique (classic 2D lighting, no normal maps): each frame fill a
 * screen-sized RenderTexture with the time-of-day tint, then ERASE a soft
 * radial brush where each light is → the world shows through in lit pools.
 * Warm glow is a separate additive layer in world space so lanterns feel cozy.
 */

export interface LightSource {
  x: number; // world coords
  y: number;
  radius?: number; // override the preset radius
  // Emissive colour (e.g. lava orange, crystal cyan). Coloured lights glow
  // even in full daylight; uncoloured ones (player lanterns) only at night.
  color?: number;
  // Explicit glow strength: a light with `alpha` set is ALWAYS drawn at that
  // alpha.
  alpha?: number;
  // Scene depth for the glow. Lights that belong IN the world (e.g. lava)
  // pass the emitter's depth so walls in front genuinely occlude them —
  // light must never shine through solid objects. Default: top overlay.
  depth?: number;
  // Ground-pool light: squash the glow to the iso ground ratio so it reads
  // as light LYING ON the ground, not a flat disc pasted over the scene.
  ground?: boolean;
}

export interface Preset {
  name: string;
  tint: number; // ambient darkness colour
  darkness: number; // 0 = full day (layer off), 1 = pitch black
  light: number; // warm glow colour
  radius: number; // light-pool radius (px)
  vignette: number; // edge-darkening alpha
}

// It is always NIGHT for now (WorldScene calls setPreset("night")); the other
// presets are kept for when a day/night cycle lands.
// tint = the multiply GRADE colour (what pure white becomes); darkness > 0
// simply enables the grade. Saturated grade colours keep the scene rich —
// night goes deep blue (Sea of Stars-style), not translucent gray.
export const PRESETS: Preset[] = [
  { name: "day", tint: 0xffffff, darkness: 0.0, light: 0xffffff, radius: 200, vignette: 0.0 },
  { name: "dusk", tint: 0xd18f70, darkness: 0.5, light: 0xffcf94, radius: 210, vignette: 0.18 },
  { name: "night", tint: 0x38445e, darkness: 1.0, light: 0xffe4ad, radius: 170, vignette: 0.28 },
  { name: "dawn", tint: 0xc9a4c4, darkness: 0.4, light: 0xfff1d6, radius: 210, vignette: 0.14 },
];

const LIGHT_TEX = "atmo-light";
const DARK_DEPTH = 900_000; // above players, below the DOM/HUD
const GLOW_DEPTH = 900_001;
const VIGNETTE_DEPTH = 900_002;

export class Atmosphere {
  /** When the shader night owns the screen, the grade layer stands down. */
  suppressGrade = false;
  private scene: Phaser.Scene;
  private presetIdx = 0;

  private dark!: Phaser.GameObjects.RenderTexture;
  private eraser!: Phaser.GameObjects.Image; // reusable brush for ERASE
  private glows: Phaser.GameObjects.Image[] = []; // additive warm pool (world space)
  private vignette!: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  get preset(): Preset {
    return PRESETS[this.presetIdx];
  }

  create() {
    this.buildBrush();

    const { width, height } = this.scene.scale;
    // MULTIPLY blend: the layer GRADES the scene (shadows stay saturated,
    // contrast survives) instead of washing it flat like an alpha overlay.
    this.dark = this.scene.add
      .renderTexture(0, 0, width, height)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setBlendMode(Phaser.BlendModes.MULTIPLY)
      .setDepth(DARK_DEPTH);

    this.eraser = this.scene.make.image({ key: LIGHT_TEX }, false).setVisible(false);

    this.vignette = this.scene.add
      .image(width / 2, height / 2, buildVignette(this.scene, width, height))
      .setScrollFactor(0)
      .setDepth(VIGNETTE_DEPTH)
      .setVisible(false);

    this.scene.scale.on("resize", this.onResize, this);
  }

  private onResize(gameSize: Phaser.Structs.Size) {
    const { width, height } = gameSize;
    this.dark.setSize(width, height);
    this.vignette.setTexture(buildVignette(this.scene, width, height)).setPosition(width / 2, height / 2);
  }

  setPreset(name: string): string {
    const i = PRESETS.findIndex((p) => p.name === name);
    if (i >= 0) this.presetIdx = i;
    return this.preset.name;
  }

  /** Redraw the atmosphere for this frame given the lights (world coords). */
  update(lights: LightSource[], cam: Phaser.Cameras.Scene2D.Camera, _dt: number) {
    const p = this.preset;

    const dark = p.darkness > 0 && !this.suppressGrade;
    if (!dark) {
      this.dark.setVisible(false);
    } else {
      this.dark.setVisible(true);
      this.dark.clear();
      this.dark.fill(p.tint, 1);
      // Erase a soft pool through the darkness at each light (screen space).
      for (const l of lights) {
        const r = l.radius ?? p.radius;
        const sx = (l.x - cam.worldView.x) * cam.zoom;
        const sy = (l.y - cam.worldView.y) * cam.zoom;
        this.eraser.setDisplaySize(r * 2, r * 2);
        this.dark.erase(this.eraser, sx, sy);
      }
    }
    // The vignette belongs to the time of day, not the grade — the shader
    // night keeps it (the reference look has strongly darkened corners).
    this.vignette.setVisible(p.darkness > 0 && p.vignette > 0).setAlpha(p.vignette);

    // Additive glow cores (world space). Coloured (emissive) lights glow even
    // in daylight — lava should read hot at noon; lanterns only at night.
    this.syncGlowPool(lights.length);
    this.glows.forEach((g, i) => {
      const l = lights[i];
      const always = l && l.alpha !== undefined;
      if (!l || (!dark && !l.color && !always)) {
        g.setVisible(false);
        return;
      }
      const r = (l.radius ?? p.radius) * (dark ? 1.15 : 0.8);
      const h = l.ground ? r * 2 * ((ISO_DY / ISO_DX) * 1.6) : r * 2;
      g.setVisible(true)
        .setPosition(l.x, l.y)
        .setDisplaySize(r * 2, h)
        .setDepth(l.depth ?? GLOW_DEPTH)
        .setTint(l.color ?? p.light)
        .setAlpha(l.alpha ?? (l.color ? (dark ? 0.6 : 0.3) : 0.5));
    });
  }

  private syncGlowPool(n: number) {
    while (this.glows.length < n) {
      const g = this.scene.add
        .image(0, 0, LIGHT_TEX)
        .setScrollFactor(1)
        .setDepth(GLOW_DEPTH)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setAlpha(0.5);
      this.glows.push(g);
    }
  }

  private buildBrush() {
    if (this.scene.textures.exists(LIGHT_TEX)) return;
    const size = 256;
    const tex = this.scene.textures.createCanvas(LIGHT_TEX, size, size);
    const ctx = tex!.getContext();
    const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.55, "rgba(255,255,255,0.6)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    tex!.refresh();
  }

  destroy() {
    this.scene.scale.off("resize", this.onResize, this);
  }
}

let vignetteCount = 0;
function buildVignette(scene: Phaser.Scene, width: number, height: number): string {
  const key = `atmo-vignette-${vignetteCount++}`;
  const tex = scene.textures.createCanvas(key, width, height);
  const ctx = tex!.getContext();
  const grd = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.32,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.72,
  );
  grd.addColorStop(0, "rgba(0,0,0,0)");
  grd.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, width, height);
  tex!.refresh();
  return key;
}

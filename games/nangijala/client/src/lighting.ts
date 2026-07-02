import Phaser from "phaser";

/**
 * Atmosphere layer: a screen-space darkness overlay that light sources punch
 * soft pools through, warm additive glows on each light, a vignette, and
 * optional drifting fog. Gives the flat pixel world depth and mood.
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
}

export interface Preset {
  name: string;
  tint: number; // ambient darkness colour
  darkness: number; // 0 = full day (layer off), 1 = pitch black
  light: number; // warm glow colour
  radius: number; // light-pool radius (px)
  vignette: number; // edge-darkening alpha
}

// Cycle order. "day" is the default and fully disables the layer, so normal
// play is untouched until you press L to explore the moodier times.
export const PRESETS: Preset[] = [
  { name: "day", tint: 0x000000, darkness: 0.0, light: 0xffffff, radius: 200, vignette: 0.0 },
  { name: "dusk", tint: 0x3a2140, darkness: 0.4, light: 0xffcf94, radius: 210, vignette: 0.22 },
  { name: "night", tint: 0x0a1230, darkness: 0.66, light: 0xffe4ad, radius: 170, vignette: 0.34 },
  { name: "dawn", tint: 0x243450, darkness: 0.32, light: 0xfff1d6, radius: 210, vignette: 0.18 },
];

const LIGHT_TEX = "atmo-light";
const FOG_TEX = "atmo-fog";
const DARK_DEPTH = 900_000; // above players, below the DOM/HUD
const GLOW_DEPTH = 900_001;
const VIGNETTE_DEPTH = 900_002;
const FOG_DEPTH = 899_999;

export class Atmosphere {
  private scene: Phaser.Scene;
  private presetIdx = 0;
  private fogOn = false;

  private dark!: Phaser.GameObjects.RenderTexture;
  private eraser!: Phaser.GameObjects.Image; // reusable brush for ERASE
  private glows: Phaser.GameObjects.Image[] = []; // additive warm pool (world space)
  private vignette!: Phaser.GameObjects.Image;
  private fog!: Phaser.GameObjects.TileSprite;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  get preset(): Preset {
    return PRESETS[this.presetIdx];
  }

  create() {
    this.buildBrush();
    this.buildFogTexture();

    const { width, height } = this.scene.scale;
    this.dark = this.scene.add
      .renderTexture(0, 0, width, height)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(DARK_DEPTH);

    this.eraser = this.scene.make.image({ key: LIGHT_TEX }, false).setVisible(false);

    this.vignette = this.scene.add
      .image(width / 2, height / 2, buildVignette(this.scene, width, height))
      .setScrollFactor(0)
      .setDepth(VIGNETTE_DEPTH)
      .setVisible(false);

    this.fog = this.scene.add
      .tileSprite(0, 0, width, height, FOG_TEX)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(FOG_DEPTH)
      .setBlendMode(Phaser.BlendModes.SCREEN)
      .setAlpha(0.16)
      .setVisible(false);

    this.scene.scale.on("resize", this.onResize, this);
  }

  private onResize(gameSize: Phaser.Structs.Size) {
    const { width, height } = gameSize;
    this.dark.setSize(width, height);
    this.vignette.setTexture(buildVignette(this.scene, width, height)).setPosition(width / 2, height / 2);
    this.fog.setSize(width, height);
  }

  cyclePreset(): string {
    this.presetIdx = (this.presetIdx + 1) % PRESETS.length;
    return this.preset.name;
  }

  setPreset(name: string): string {
    const i = PRESETS.findIndex((p) => p.name === name);
    if (i >= 0) this.presetIdx = i;
    return this.preset.name;
  }

  toggleFog(): boolean {
    this.fogOn = !this.fogOn;
    return this.fogOn;
  }

  /** Redraw the atmosphere for this frame given the lights (world coords). */
  update(lights: LightSource[], cam: Phaser.Cameras.Scene2D.Camera, dt: number) {
    const p = this.preset;

    // Drifting fog is independent of time-of-day.
    this.fog.setVisible(this.fogOn);
    if (this.fogOn) {
      this.fog.tilePositionX += dt * 6;
      this.fog.tilePositionY += dt * 2.5;
    }

    const dark = p.darkness > 0;
    if (!dark) {
      this.dark.setVisible(false);
      this.vignette.setVisible(false);
    } else {
      this.dark.setVisible(true);
      this.dark.clear();
      this.dark.fill(p.tint, p.darkness);
      // Erase a soft pool through the darkness at each light (screen space).
      for (const l of lights) {
        const r = l.radius ?? p.radius;
        const sx = (l.x - cam.worldView.x) * cam.zoom;
        const sy = (l.y - cam.worldView.y) * cam.zoom;
        this.eraser.setDisplaySize(r * 2, r * 2);
        this.dark.erase(this.eraser, sx, sy);
      }
      this.vignette.setVisible(p.vignette > 0).setAlpha(p.vignette);
    }

    // Additive glow cores (world space). Coloured (emissive) lights glow even
    // in daylight — lava should read hot at noon; lanterns only at night.
    this.syncGlowPool(lights.length);
    this.glows.forEach((g, i) => {
      const l = lights[i];
      if (!l || (!dark && !l.color)) {
        g.setVisible(false);
        return;
      }
      const r = (l.radius ?? p.radius) * (dark ? 1.15 : 0.8);
      g.setVisible(true)
        .setPosition(l.x, l.y)
        .setDisplaySize(r * 2, r * 2)
        .setTint(l.color ?? p.light)
        .setAlpha(l.color ? (dark ? 0.6 : 0.3) : 0.5);
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

  private buildFogTexture() {
    if (this.scene.textures.exists(FOG_TEX)) return;
    const size = 256;
    const tex = this.scene.textures.createCanvas(FOG_TEX, size, size);
    const ctx = tex!.getContext();
    ctx.clearRect(0, 0, size, size);
    // Soft overlapping blobs → cloudy fog that tiles seamlessly (wrap draw).
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 24 + Math.random() * 48;
      for (const [ox, oy] of [
        [0, 0],
        [size, 0],
        [-size, 0],
        [0, size],
        [0, -size],
      ]) {
        const grd = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grd.addColorStop(0, "rgba(210,220,235,0.5)");
        grd.addColorStop(1, "rgba(210,220,235,0)");
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, size, size);
      }
    }
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

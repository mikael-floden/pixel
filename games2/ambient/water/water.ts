import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";

// Living water — a FIELD that makes lakes/sea feel ALIVE without building foam
// (maintainer 2026-07-19: "small waves and random movement", "pixel-art style
// animation that moves in full pixels, not sub-px translation", "sun reflections
// … take time-of-day into account, moon reflections at night"). Two kinds of
// tiny hand-pixelled marks are scattered over the VISIBLE WATER (found through
// the game's `waterAtScreen` iso probe — the same one the snow uses):
//
//   • WAVELETS — a small light crest that ANIMATES in place through a few
//     pixel frames (a bob), then fades and RESPAWNS at another random water
//     spot. The "movement" is the flicker + the respawns, all snapped to whole
//     world pixels (integer positions, scale 1, nearest) — never a sub-pixel
//     slide. Drawn below the night overlay so night water stays calm/dark.
//   • GLINTS — sun/moon reflection sparkles, ADDITIVE and ABOVE the darkness
//     overlay so they shine even at night. Colour + count + brightness come
//     from the time of day: warm white when the sun is up (whiter at noon,
//     amber at dawn/dusk), and a cooler, dimmer, sparser MOON glint at night.
//
// Pixel-perfect: 1 art-px == 1 world-px (scale 1), integer positions, so the
// marks share the exact pixel grid as the characters/world. Self-gates on
// water being on screen; costs almost nothing over dry land.
// Both layers sit ABOVE the darkness overlay (900_000) so the night can't
// multiply them into nothing — instead we DRIVE their look by the time of day
// ourselves (bright cyan crests + warm sun sparkles by day; faint moonlit-blue
// crests + cool moon sparkles by night). Below the lit avatar copies, so a
// swimmer still reads in front of the water.
const DEPTH_WAVE = 900_000.4;
const DEPTH_GLINT = 900_000.45;
const GAIN_TAU = 1200;
const SAMPLE_MS = 150; // how often we re-scan the view for water
const GRID = 6; // GRID×GRID water probe samples across the view
const AREA_PER_WAVE = 4200; // ~ waves per water on a phone view
const AREA_PER_GLINT = 6400;
const MAX_WAVE = 46;
const MAX_GLINT = 40;

const WAVE_FRAMES = ["amb-wave0", "amb-wave1", "amb-wave2"];
const GLINT_FRAMES = ["amb-glint0", "amb-glint1", "amb-glint2"];
// Wavelet pixel maps — a bright crest (B) over a darker TROUGH shadow (d) that
// together read as a little wave; the crest slides a pixel each frame so the
// wave ROLLS in whole pixels. 7×2.
const W0 = { B: [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], d: [[2, 1], [3, 1], [4, 1]] };
const W1 = { B: [[2, 0], [3, 0], [4, 0], [5, 0], [6, 0]], d: [[3, 1], [4, 1], [5, 1]] };
const W2 = { B: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], d: [[1, 1], [2, 1], [3, 1]] };
// Glint sparkle pixel maps (white, tinted at runtime). 5×3.
const G0 = { B: [[1, 1], [2, 1], [3, 1]], d: [[0, 1], [4, 1]] };
const G1 = { B: [[2, 0], [2, 1], [2, 2], [1, 1], [3, 1]], d: [] as number[][] };
const G2 = { B: [[2, 1]], d: [] as number[][] };
const WAVE_BRIGHT = 0xcdeef2; // crest highlight — cyan, NOT white (avoid a foam read)
const WAVE_DIM = 0x274d51; // trough shadow (darker than the water)
const WAVE_NIGHT_TINT = 0x9db6d6; // multiplies the crest toward moonlit blue at night

const lerpC = (a: number, b: number, t: number) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    ((Math.round(ar + (br - ar) * t) << 16) |
      (Math.round(ag + (bg - ag) * t) << 8) |
      Math.round(ab + (bb - ab) * t)) >>>
    0
  );
};

/** Reflection look for the current time of day. strength 0..1 scales glint
 * count + brightness; tint is the sparkle colour; moon marks the night look. */
function reflection(env: { sun: number; night: number; cloud: number }) {
  if (env.sun > 0.12) {
    // Daytime SUN: amber at dawn/dusk (low sun), white at noon; strong.
    const tint = lerpC(0xffcf94, 0xfff4da, Math.min(1, env.sun));
    return { tint, strength: (0.35 + 0.65 * env.sun) * (1 - 0.5 * env.cloud), moon: false };
  }
  // Night MOON: cool and gentle (dimmer + a touch sparser than the sun, but
  // still a live shimmer on the dark water); washed out under heavy cloud.
  return { tint: 0xd2e2ff, strength: 0.5 * env.night * (1 - 0.6 * env.cloud), moon: true };
}

interface Mark {
  sprite: Phaser.GameObjects.Image;
  x: number;
  y: number;
  fi: number; // frame index into the sequence
  seqT: number; // ms into the current frame
  frameDur: number;
  life: number; // ms remaining
  maxLife: number;
  base: number; // per-mark peak alpha
}

export function waterFeature(): AmbientFeature {
  const waves: Mark[] = [];
  const glints: Mark[] = [];
  let gain = 0;
  let suppressed = false;
  let forced = false;
  let sampleAge = SAMPLE_MS;
  let waterPts: { x: number; y: number }[] = [];
  let waterFrac = 0;
  let lastMoon = false; // which reflection is live (for debug)
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff;

  const waterAt = (wx: number, wy: number): boolean => {
    const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
    const f = ml?.waterAtScreen as undefined | ((x: number, y: number) => boolean);
    return f ? !!f(wx, wy) : false;
  };

  const ensureTextures = (scene: Phaser.Scene) => {
    if (scene.textures.exists(WAVE_FRAMES[0])) return;
    const paint = (key: string, w: number, h: number, map: { B: number[][]; d: number[][] }, bright: number, dim: number) => {
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      g.fillStyle(dim, 1);
      for (const [x, y] of map.d) g.fillRect(x, y, 1, 1);
      g.fillStyle(bright, 1);
      for (const [x, y] of map.B) g.fillRect(x, y, 1, 1);
      g.generateTexture(key, w, h);
      g.destroy();
    };
    paint(WAVE_FRAMES[0], 7, 2, W0, WAVE_BRIGHT, WAVE_DIM);
    paint(WAVE_FRAMES[1], 7, 2, W1, WAVE_BRIGHT, WAVE_DIM);
    paint(WAVE_FRAMES[2], 7, 2, W2, WAVE_BRIGHT, WAVE_DIM);
    // Glints are pure white — tinted per mark to the sun/moon colour.
    paint(GLINT_FRAMES[0], 5, 3, G0, 0xffffff, 0xffffff);
    paint(GLINT_FRAMES[1], 5, 3, G1, 0xffffff, 0xffffff);
    paint(GLINT_FRAMES[2], 5, 3, G2, 0xffffff, 0xffffff);
  };

  // Drop a mark onto a random visible water point (integer world px). Returns
  // false when there's no water to land on (the mark stays hidden).
  const placeOnWater = (m: Mark): boolean => {
    if (!waterPts.length) return false;
    const p = waterPts[(rnd() * waterPts.length) | 0];
    const jx = Math.round((rnd() - 0.5) * 22);
    const jy = Math.round((rnd() - 0.5) * 14);
    let x = Math.round(p.x + jx);
    let y = Math.round(p.y + jy);
    if (!waterAt(x, y)) {
      x = Math.round(p.x);
      y = Math.round(p.y);
    }
    m.x = x;
    m.y = y;
    return true;
  };

  const makeMark = (scene: Phaser.Scene, frames: string[], depth: number, additive: boolean): Mark => {
    const sprite = scene.add
      .image(0, 0, frames[0])
      .setDepth(depth)
      .setScale(1)
      .setVisible(false);
    if (additive) sprite.setBlendMode(Phaser.BlendModes.ADD);
    return { sprite, x: 0, y: 0, fi: 0, seqT: 0, frameDur: 120, life: 0, maxLife: 1, base: 1 };
  };

  const resetWave = (m: Mark) => {
    m.fi = (rnd() * WAVE_FRAMES.length) | 0;
    m.seqT = 0;
    m.frameDur = 150 + rnd() * 140; // slow roll
    m.maxLife = m.life = 1400 + rnd() * 2200;
    m.base = 0.5 + rnd() * 0.4;
  };
  const resetGlint = (m: Mark, tint: number) => {
    m.fi = (rnd() * GLINT_FRAMES.length) | 0;
    m.seqT = 0;
    m.frameDur = 70 + rnd() * 90; // quick twinkle
    m.maxLife = m.life = 500 + rnd() * 1100;
    m.base = 0.45 + rnd() * 0.5;
    m.sprite.setTint(tint);
  };

  // Advance a mark's animation + fade; returns the envelope alpha (0 = dead).
  const stepMark = (m: Mark, frames: string[], dt: number): number => {
    m.life -= dt;
    m.seqT += dt;
    if (m.seqT >= m.frameDur) {
      m.seqT -= m.frameDur;
      m.fi = (m.fi + 1) % frames.length;
      m.sprite.setTexture(frames[m.fi]);
    }
    const p = 1 - m.life / m.maxLife; // 0..1 over life
    // Fade in over the first 20%, hold, fade out over the last 30%.
    const env = p < 0.2 ? p / 0.2 : p > 0.7 ? Math.max(0, (1 - p) / 0.3) : 1;
    return env * m.base;
  };

  return {
    name: "water",
    init(ctx) {
      ensureTextures(ctx.scene);
    },
    update(ctx, dt) {
      const view = ctx.view;
      // Re-scan the view for water on a throttle (the probe allocates a little).
      sampleAge += dt;
      if (sampleAge >= SAMPLE_MS) {
        sampleAge = 0;
        const pts: { x: number; y: number }[] = [];
        for (let i = 0; i < GRID; i++)
          for (let j = 0; j < GRID; j++) {
            const wx = view.x + ((i + 0.5) / GRID) * view.width;
            const wy = view.y + ((j + 0.5) / GRID) * view.height;
            if (waterAt(wx, wy)) pts.push({ x: wx, y: wy });
          }
        waterPts = pts;
        waterFrac = pts.length / (GRID * GRID);
      }

      const target = forced ? 1 : suppressed ? 0 : waterFrac > 0 ? 1 : 0;
      gain += (target - gain) * Math.min(1, (dt / GAIN_TAU) * 3);
      const refl = reflection(ctx.env);
      lastMoon = refl.moon;

      // Pool sizes follow the visible water area (and, for glints, the sun/moon
      // strength). No water in view → everything empties out.
      const area = view.width * view.height;
      const wantWave = gain < 0.02
        ? 0
        : Math.min(MAX_WAVE, Math.round((area / AREA_PER_WAVE) * waterFrac));
      const wantGlint = gain < 0.02
        ? 0
        : Math.min(MAX_GLINT, Math.round((area / AREA_PER_GLINT) * waterFrac * refl.strength));

      while (waves.length < wantWave) waves.push(makeMark(ctx.scene, WAVE_FRAMES, DEPTH_WAVE, false));
      while (glints.length < wantGlint) glints.push(makeMark(ctx.scene, GLINT_FRAMES, DEPTH_GLINT, true));
      while (waves.length > wantWave) waves.pop()!.sprite.destroy();
      while (glints.length > wantGlint) glints.pop()!.sprite.destroy();

      const dtc = Math.min(dt, 100);
      // Wave look by time of day: strong bright cyan crests by day, faint
      // moonlit-blue crests at night (we're above the overlay, so drive it here).
      const waveK = 0.34 + 0.66 * ctx.env.sun;
      const waveTint = lerpC(WAVE_NIGHT_TINT, 0xffffff, ctx.env.sun);
      for (const m of waves) {
        if (m.life <= 0) {
          if (!placeOnWater(m)) {
            m.sprite.setVisible(false);
            continue;
          }
          resetWave(m);
        }
        const a = stepMark(m, WAVE_FRAMES, dtc);
        m.sprite.setTint(waveTint).setPosition(m.x, m.y).setAlpha(gain * a * waveK).setVisible(a > 0.01);
      }
      for (const m of glints) {
        if (m.life <= 0) {
          if (!placeOnWater(m)) {
            m.sprite.setVisible(false);
            continue;
          }
          resetGlint(m, refl.tint);
        }
        const a = stepMark(m, GLINT_FRAMES, dtc);
        m.sprite.setPosition(m.x, m.y).setAlpha(gain * refl.strength * a).setVisible(a > 0.01);
      }
    },
    setSuppressed(on) {
      suppressed = on;
    },
    setForced(on) {
      forced = on;
    },
    debug() {
      const litW = waves.filter((m) => m.sprite.visible).length;
      const litG = glints.filter((m) => m.sprite.visible).length;
      return {
        gain,
        suppressed,
        forced,
        waterFrac,
        waves: waves.length,
        glints: glints.length,
        lit: litW + litG,
        litWaves: litW,
        litGlints: litG,
        moon: lastMoon,
      };
    },
    dispose() {
      for (const m of waves) m.sprite.destroy();
      for (const m of glints) m.sprite.destroy();
      waves.length = 0;
      glints.length = 0;
    },
  };
}

import Phaser from "phaser";
import { AmbientCtx, AmbientFeature } from "../runtime/types";

// Living water — a FIELD that makes lakes/sea feel ALIVE without building foam
// (maintainer 2026-07-19: "small waves and random movement", "pixel-art style
// animation that moves in full pixels, not sub-px translation", "sun reflections
// … take time-of-day into account, moon reflections at night"). Two kinds of
// tiny hand-pixelled marks are scattered over the VISIBLE WATER (found through
// the game's `waterAtScreen` iso probe — the same one the snow uses):
//
//   • WAVELETS — a HORIZONTAL line (a dim crest over a toned-down thin shadow)
//     with a bright SHIMMER that marches along it a pixel per frame — an
//     in-place animated glint, not the object sliding. Then it fades and
//     RESPAWNS elsewhere. All snapped to whole world pixels (integer positions,
//     scale 1, nearest) — never a sub-pixel slide.
//   • GLINTS — sun/moon reflection sparkles, ADDITIVE, shaped like a plus with
//     one arm missing (a "tetromino") and turned a random quarter-turn for four
//     orientations. Colour + count + brightness come from the time of day: warm
//     white when the sun is up (whiter at noon, amber at dawn/dusk), a cooler,
//     dimmer, sparser MOON glint at night.
//
// Marks only land on INTERIOR water (all sides water — off shorelines/hillside
// faces), keep MIN_DIST apart (no two on top of each other), and their fade is
// STEPPED into a few levels so they pop like animated pixel art, not a smooth
// dissolve.
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
const GRID = 8; // GRID×GRID water probe samples across the view (spawn candidates)
const AREA_PER_WAVE = 8000; // ~ waves per water on a phone view (sparse — spacing matters)
const AREA_PER_GLINT = 11000;
const MAX_WAVE = 26;
const MAX_GLINT = 18;
const INTERIOR = 18; // a mark must have water this far out on all sides (off shorelines/cliffs)
const MIN_DIST = 24; // marks keep at least this far apart (Chebyshev)
const PLACE_TRIES = 12; // attempts to find an interior, spaced spot before giving up
const ROT4 = [0, 90, 180, 270]; // whole-quarter turns keep pixels grid-aligned

const WAVE_FRAMES = ["amb-wave0", "amb-wave1", "amb-wave2", "amb-wave3"];
const GLINT_FRAMES = ["amb-glint0", "amb-glint1", "amb-glint2"];
// Wavelet — a HORIZONTAL line (maintainer liked these over the diagonals),
// drawn ADDITIVE like the spark glints so it reads with the same CRISP WHITE
// PUNCH (maintainer: "the white lines lack the crisp punchiness the spark
// brings"). A 5px bright cyan-white crest (m) with a pure-WHITE shimmer pair
// (B) marching along it a pixel per frame — an in-place animated glint, not the
// object sliding. No dark trough (additive can't darken, and it wanted toning
// down anyway). 7×1, no rotation (kept horizontal).
type WMap = { m: number[][]; B: number[][] };
const wshimmer = (b: number): WMap => {
  const m: number[][] = [];
  const B: number[][] = [];
  for (let x = 1; x <= 5; x++) (x === b || x === b + 1 ? B : m).push([x, 0]);
  return { m, B };
};
const WF = [wshimmer(1), wshimmer(2), wshimmer(3), wshimmer(4)]; // shimmer travels right
// Glint "tetromino" — a plus with ONE arm pixel missing (asymmetric), so a
// random quarter-turn gives four distinct sparkles (maintainer). 3×3; the
// twinkle steps down the shape. White, tinted per mark to sun/moon.
const G0 = [[1, 0], [1, 1], [1, 2], [2, 1]]; // full T (missing left)
const G1 = [[1, 1], [2, 1]]; // shrunk
const G2 = [[1, 1]]; // point
const WAVE_BRIGHT = 0xffffff; // pure-white shimmer glint — crisp, exactly like the spark
const WAVE_MID = 0xcdeef2; // the crest LINE — bright cyan-white (additive → crisp punch)
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
    // Paint painted-in-order colour LAYERS (later layers draw on top).
    const paint = (key: string, w: number, h: number, layers: { c: number; px: number[][] }[]) => {
      const g = scene.make.graphics({ x: 0, y: 0 }, false);
      for (const { c, px } of layers) {
        g.fillStyle(c, 1);
        for (const [x, y] of px) g.fillRect(x, y, 1, 1);
      }
      g.generateTexture(key, w, h);
      g.destroy();
    };
    WF.forEach((f, i) =>
      paint(WAVE_FRAMES[i], 7, 1, [
        { c: WAVE_MID, px: f.m },
        { c: WAVE_BRIGHT, px: f.B },
      ]),
    );
    // Glints are pure white — tinted per mark to the sun/moon colour.
    [G0, G1, G2].forEach((px, i) => paint(GLINT_FRAMES[i], 3, 3, [{ c: 0xffffff, px }]));
  };

  const tooClose = (x: number, y: number, self: Mark): boolean => {
    for (const o of waves)
      if (o !== self && o.sprite.visible && Math.abs(o.x - x) < MIN_DIST && Math.abs(o.y - y) < MIN_DIST) return true;
    for (const o of glints)
      if (o !== self && o.sprite.visible && Math.abs(o.x - x) < MIN_DIST && Math.abs(o.y - y) < MIN_DIST) return true;
    return false;
  };

  // Drop a mark onto INTERIOR visible water (all four sides water — never on a
  // shoreline or a tile's hillside face) with SPACING from other marks (integer
  // world px). Returns false when no good spot is found (the mark stays hidden).
  const placeOnWater = (m: Mark): boolean => {
    if (!waterPts.length) return false;
    for (let tries = 0; tries < PLACE_TRIES; tries++) {
      const p = waterPts[(rnd() * waterPts.length) | 0];
      const x = Math.round(p.x + (rnd() - 0.5) * 26);
      const y = Math.round(p.y + (rnd() - 0.5) * 18);
      if (
        !waterAt(x, y) ||
        !waterAt(x + INTERIOR, y) ||
        !waterAt(x - INTERIOR, y) ||
        !waterAt(x, y + INTERIOR) ||
        !waterAt(x, y - INTERIOR)
      )
        continue; // on/near an edge — the hillside bug
      if (tooClose(x, y, m)) continue; // overlapping another mark
      m.x = x;
      m.y = y;
      return true;
    }
    return false;
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
    m.frameDur = 110 + rnd() * 90; // shimmer travel speed
    m.maxLife = m.life = 1500 + rnd() * 2400;
    m.base = 0.5 + rnd() * 0.4;
    m.sprite.setAngle(0); // HORIZONTAL only (maintainer preferred these)
  };
  const resetGlint = (m: Mark, tint: number) => {
    m.fi = (rnd() * GLINT_FRAMES.length) | 0;
    m.seqT = 0;
    m.frameDur = 70 + rnd() * 90; // quick twinkle
    m.maxLife = m.life = 500 + rnd() * 1100;
    m.base = 0.45 + rnd() * 0.5;
    m.sprite.setAngle(ROT4[(rnd() * 4) | 0]).setTint(tint); // 4 tetromino orientations
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
    // Fade in over the first 18%, hold, fade out over the last 28% — but STEP
    // the envelope into a few discrete levels so it pops in/out like animated
    // pixel art, not a smooth CSS-style dissolve (maintainer).
    const raw = p < 0.18 ? p / 0.18 : p > 0.72 ? (1 - p) / 0.28 : 1;
    const stepped = Math.ceil(Math.max(0, Math.min(1, raw)) * 3) / 3; // 0, ⅓, ⅔, 1
    return stepped * m.base;
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

      while (waves.length < wantWave) waves.push(makeMark(ctx.scene, WAVE_FRAMES, DEPTH_WAVE, true));
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

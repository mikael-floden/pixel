import Phaser from "phaser";
import { vectorToDirection } from "@nangijala/shared";

// Shared helpers for the SPRITE-ART flocks (birds, bats). The creatures are
// PixelLab "low top-down" 8-direction objects packed into two spritesheets per
// type:
//   • fly.png   — FLY_FRAMES columns (the flap cycle) × 8 rows (one per facing).
//                 frame index = dir*FLY_FRAMES + f  (see flyFrame()).
//   • still.png — 8 columns (a still base, one per facing). frame index = dir.
// The 8 rows are in PixelLab's rotation order (below) — which is the MIRROR of
// shared/DIRECTIONS — so a facing is resolved by NAME, never by array index.
export const FRAME_W = 34;
export const FRAME_H = 34;
export const FLY_FRAMES = 16;

// PixelLab row order (index 0..7). Do NOT reuse shared/DIRECTIONS.indexOf here —
// that array rotates the other way (S,SW,W,…) and would swap east/west.
const DIR_INDEX: Record<string, number> = {
  south: 0,
  "south-east": 1,
  east: 2,
  "north-east": 3,
  north: 4,
  "north-west": 5,
  west: 6,
  "south-west": 7,
};

/** Row-major frame index into a fly spritesheet (16 cols × 8 rows). */
export const flyFrame = (dir: number, frame = 0): number => dir * FLY_FRAMES + frame;

/** A flock creature's velocity → PixelLab facing index 0..7, or null when there
 * is no meaningful heading (near-zero speed → keep the last facing). The flock
 * gx/gy/vx/vy already live in the DRAWN (iso-projected) space — the same screen
 * vector the player's own facing uses — so the velocity goes straight into the
 * game's shared vectorToDirection (screen +y is down). */
export function dirFromVel(vx: number, vy: number): number | null {
  if (Math.abs(vx) < 0.01 && Math.abs(vy) < 0.01) return null;
  const name = vectorToDirection(vx, vy);
  return name ? DIR_INDEX[name] ?? null : null;
}

/** Shortest step count between two 8-way facings (0..4) — a 1-step change is an
 * adjacent-sector flip (hysteresis territory), ≥2 is a real turn. */
function dirGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 8;
  return Math.min(d, 8 - d);
}

/** The per-agent draw state both flocks share (a Bird/Bat is a structural
 * superset). Advanced together each frame by stepFlapDir. */
export interface FlapState {
  dir: number; // current facing (PixelLab index 0..7), hysteretic
  dirHoldT: number; // ms an adjacent new heading has persisted
  vx: number;
  vy: number;
  frame: number; // flap frame 0..FLY_FRAMES-1
  flapMs: number; // ms per flap frame
  flapT: number;
}

/** Advance a creature's FACING and FLAP frame by dt ms. Facing snaps on a real
 * turn (≥2 sectors) but an adjacent-sector flip must persist `stick` ms first,
 * so a boid wobbling across an 8-way boundary doesn't jitter the sprite;
 * near-zero velocity keeps the last facing. Display-only — never touches the
 * boids force math. Mutates dir/dirHoldT/frame/flapT in place. */
export function stepFlapDir(b: FlapState, dt: number, stick: number): void {
  const cand = dirFromVel(b.vx, b.vy);
  if (cand !== null && cand !== b.dir) {
    if (dirGap(cand, b.dir) >= 2) {
      b.dir = cand; // a real turn — snap immediately
      b.dirHoldT = 0;
    } else {
      b.dirHoldT += dt; // an adjacent flip — only turn if it persists
      if (b.dirHoldT >= stick) {
        b.dir = cand;
        b.dirHoldT = 0;
      }
    }
  } else {
    b.dirHoldT = 0;
  }
  b.flapT += dt;
  if (b.flapT >= b.flapMs) {
    b.flapT -= b.flapMs;
    b.frame = (b.frame + 1) % FLY_FRAMES;
  }
}

/** The world light + depth-fog haze for one flock creature, PER BIRD, at its own
 * ground point + altitude. `tint` is a MULTIPLY tint (day/night + cloud +
 * directional-sun CAST SHADOW + point lights — so a bird sitting in a cliff's
 * shadow darkens while one in the sun stays bright); `fog`/`fogTint` are the
 * depth-fog opacity + colour so a far/high bird hazes into the fog like the
 * terrain does. */
export interface CritterGrade {
  tint: number;
  fog: number;
  fogTint: number;
  groundL: number; // resolved terrain level under the creature (for the shadow's depth)
}

/** Per-creature EASED lighting state (see gradeCritter). Both Bird and Bat carry
 * these fields so the grade can smooth the discrete terrain jump at a cliff.
 * Undefined until the first sample (then snapped, never ramped from black). */
export interface CritterGradeState {
  gl?: [number, number, number]; // eased light multiplier (r,g,b), 0..~N
  gfa?: number; // eased fog alpha, 0..1
  gfc?: [number, number, number]; // eased fog colour (r,g,b), 0..1
}

// The raw floats __ml.critterLight returns (light multipliers + fog + resolved terrain).
interface CritterProbe {
  l: [number, number, number];
  fog: number;
  fogCol: [number, number, number];
  L: number; // resolved DRAWN terrain level under the ground point
}

const LEVEL_PX = 16; // MAP_GEOMETRY.lh — px per elevation level (kept local, no cross-import)

// Ease time-constants (ms). critterLight now resolves the bird's ground level as
// the DRAWN level up a cliff face (not the wall top), so the raw grade already
// ramps smoothly instead of snapping ~20 levels at a wall. Easing is the safety
// net: it smooths any residual per-frame step (a fast bird stepping 1-2 levels,
// or crossing a cell/occlusion boundary) — the same trick the avatar uses for
// elevation snaps. Fog swings are bigger, so it eases a touch slower than the tint.
const GRADE_TAU = 130;
const FOG_TAU = 165;
const FOG_EPS = 0.01; // "is there real fog?" threshold for the colour track (see gradeCritter)

/** Probe the world light + depth-fog for a flyer whose GROUND point is drawn at
 * iso-screen (gx,gy) and lifted `alt` px above it — through the game's
 * face-aware __ml.critterLight (the flat flock sim can't do the iso inverse
 * itself: it has no terrain heights) — then EASE the result into the creature's
 * own `st` so a discrete terrain-level jump at a cliff foot doesn't snap the
 * shadow/fog. Cast-shadow-aware AND altitude-aware; never reads screen pixels.
 * Both the light multiplier AND the fog (opacity + colour) ease, so neither the
 * cast-shadow tint nor the haze ever snaps — including a LANDED bird (a stationary
 * bird's grade just converges and stays; the ~0.1s lag is imperceptible, and
 * NOT easing it snapped the fog on the touchdown frame when there was residual
 * lag). Falls back to full brightness + no fog if the probe is missing. Pass the
 * SAME dtMs the frame stepped; reset st.gl to undefined to snap on the next call
 * (first sample, or a recycled creature that just teleported across the map). */
export function gradeCritter(
  st: CritterGradeState,
  gx: number,
  gy: number,
  alt: number,
  dtMs: number,
): CritterGrade {
  const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
  const at = ml?.critterLight as undefined | ((x: number, y: number, a: number) => CritterProbe | null);
  const p = at?.(gx, gy, alt);
  const tl = p ? p.l : [1, 1, 1];
  const tf = p ? p.fog : 0;
  const fc = p ? p.fogCol : [1, 1, 1];
  if (!st.gl || !st.gfc) {
    st.gl ??= [0, 0, 0];
    st.gfc ??= [0, 0, 0];
    st.gl[0] = tl[0]; st.gl[1] = tl[1]; st.gl[2] = tl[2];
    st.gfa = tf;
    st.gfc[0] = fc[0]; st.gfc[1] = fc[1]; st.gfc[2] = fc[2];
  } else {
    const kt = 1 - Math.exp(-dtMs / GRADE_TAU);
    const kf = 1 - Math.exp(-dtMs / FOG_TAU);
    st.gl[0] += (tl[0] - st.gl[0]) * kt;
    st.gl[1] += (tl[1] - st.gl[1]) * kt;
    st.gl[2] += (tl[2] - st.gl[2]) * kt;
    const prevFa = st.gfa ?? tf;
    st.gfa = prevFa + (tf - prevFa) * kf;
    // Fog COLOUR tracks only REAL fog. depthFogAt returns a BLACK sentinel
    // ([0,0,0]) when there's no fog, so easing gfc toward it would ramp the wash
    // through black — a dark FLASH on the next fog-in (opposite of the pale haze).
    // Hold gfc while fog is negligible (invisible at ~0 alpha), snap it to the
    // real colour the instant fog starts, then ease between real fog colours.
    if (tf >= FOG_EPS) {
      if (prevFa < FOG_EPS) {
        st.gfc[0] = fc[0]; st.gfc[1] = fc[1]; st.gfc[2] = fc[2];
      } else {
        st.gfc[0] += (fc[0] - st.gfc[0]) * kf;
        st.gfc[1] += (fc[1] - st.gfc[1]) * kf;
        st.gfc[2] += (fc[2] - st.gfc[2]) * kf;
      }
    }
  }
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return {
    tint: (ch(st.gl[0]) << 16) | (ch(st.gl[1]) << 8) | ch(st.gl[2]),
    fog: st.gfa ?? 0,
    fogTint: (ch(st.gfc[0]) << 16) | (ch(st.gfc[1]) << 8) | ch(st.gfc[2]),
    groundL: p ? p.L : 0, // RAW (un-eased) terrain level — for the shadow's depth sort
  };
}

const SHADOW_KEY = "amb-critter-shadow";
/** Bake a small soft-ellipse drop shadow once (the avatar's look, smaller). */
function ensureCritterShadow(scene: Phaser.Scene): void {
  if (scene.textures.exists(SHADOW_KEY)) return;
  const w = 48, h = 20; // squashed to the iso ground ratio; sized down at draw time
  const tex = scene.textures.createCanvas(SHADOW_KEY, w, h);
  if (!tex) return;
  const ctx = tex.getContext();
  ctx.save();
  ctx.scale(1, h / w); // draw a circle in squashed space → ellipse
  const grd = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
  grd.addColorStop(0, "rgba(0,0,0,0.55)");
  grd.addColorStop(0.6, "rgba(0,0,0,0.34)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, w);
  ctx.restore();
  tex.refresh();
}

/** A SMALL ground drop-shadow under a flyer at its ground point (gx,gy), so the
 * vertical GAP up to the bird (alt px above) reads as flight height — and the
 * shadow itself shrinks + fades a little as it climbs (Mario-64 style). Drawn at
 * a WORLD-Y depth (like footsteps), NOT the bird's sky depth, so it lies on the
 * ground and DIMS with the night overlay instead of glowing over it.
 *
 * The ground point (gx,gy) already sits ON the resolved terrain SURFACE (raised
 * cells draw their top at gy), but ELEVATED terrain draws its top/face tiles as
 * separate occluder images at depth `oy+dy+(col+row)*dy == gy + L*lh` — ABOVE a
 * plain `gy` depth — so over a hill the terrain tile covered the shadow (it was
 * only visible on level-0 ground with no occluder). Raise the shadow's depth by
 * the resolved level so it sits just above its own cell's occluder. Created
 * lazily; the caller destroys it on removal. */
export function applyShadow(
  scene: Phaser.Scene,
  holder: { shadow?: Phaser.GameObjects.Image },
  gx: number,
  gy: number,
  alt: number,
  groundL: number,
): void {
  ensureCritterShadow(scene);
  const f = Math.min(1, Math.max(0, alt / 130)); // 0 on the ground → 1 at high cruise
  let s = holder.shadow;
  if (!s) {
    s = scene.add.image(gx, gy, SHADOW_KEY).setOrigin(0.5, 0.5);
    holder.shadow = s;
  }
  s.setPosition(gx, gy)
    .setDepth(gy + groundL * LEVEL_PX + 3) // just above this cell's terrain occluder; below the night overlay
    .setDisplaySize(16 - f * 6, 6.4 - f * 2.6) // much smaller than the player's ~34×14
    .setAlpha(0.58 - f * 0.24) // reads on bright sand; fainter the higher it climbs
    .setVisible(true);
}

const FOG_MIN = 0.012; // below this the haze is invisible — skip the overlay sprite entirely

/** Wash a flock creature into the depth-fog. Phaser can't LIGHTEN a sprite with
 * a single multiply tint (the base tint already carries the day/night + shadow
 * grade), so the pale fog wash rides a SECOND same-frame sprite: a tint-FILLED
 * copy at the fog opacity, composited just above the base — base·(1−a) +
 * fogColour·a over every opaque pixel, exactly the shader's NORMAL-blend fog.
 * The overlay is created lazily on first need and hidden (never destroyed) when
 * there's no fog, so a bird flying in and out of a bank costs nothing extra.
 * Mirrors the base's current frame/pos/scale/flip so it must be called AFTER the
 * base sprite is positioned for the frame. */
export function applyFog(
  scene: Phaser.Scene,
  holder: { sprite: Phaser.GameObjects.Sprite; fog?: Phaser.GameObjects.Sprite },
  grade: CritterGrade,
  alpha: number,
): void {
  const base = holder.sprite;
  if (grade.fog < FOG_MIN) {
    holder.fog?.setVisible(false);
    return;
  }
  let f = holder.fog;
  if (!f) {
    f = scene.add.sprite(base.x, base.y, base.texture.key, base.frame.name);
    holder.fog = f;
  }
  f.setTexture(base.texture.key, base.frame.name)
    .setPosition(base.x, base.y)
    .setScale(base.scaleX, base.scaleY)
    .setFlipX(base.flipX)
    .setDepth(base.depth + 0.0004) // just above this creature's base, below the next one (0.001 apart)
    .setTintFill(grade.fogTint)
    .setAlpha(Math.min(1, grade.fog) * alpha)
    .setVisible(true);
}

export interface SheetSpec {
  key: string;
  url: string;
}

const MAX_RELOAD = 3; // bounded self-heal retries per sheet key
const reloads = new Map<string, number>();

/** Queue any not-yet-loaded fly/still spritesheets and kick a runtime loader
 * pass. Ambient features init AFTER the scene's preload, so their PNG art must
 * load at runtime (scene.load + start); textures live on the global manager so
 * this is idempotent across re-inits/reconnects. Readiness is polled with
 * sheetsReady() rather than a COMPLETE callback, so it can't race a shared
 * loader batch when birds and bats both queue on the same first tick.
 *
 * A single flaky fetch must NOT silently kill the flock for the whole session
 * (sheetsReady would never go true), so an errored sheet is re-queued a few
 * times on a short backoff before giving up — degrading gracefully either way. */
export function queueSheets(scene: Phaser.Scene, specs: SheetSpec[]): void {
  const load = (s: SheetSpec) => scene.load.spritesheet(s.key, s.url, { frameWidth: FRAME_W, frameHeight: FRAME_H });
  let queued = false;
  for (const s of specs) {
    if (scene.textures.exists(s.key)) continue;
    load(s);
    queued = true;
  }
  if (!queued) return;
  scene.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
    const spec = specs.find((s) => s.key === file.key);
    if (!spec) return; // another feature's sheet
    const n = (reloads.get(spec.key) ?? 0) + 1;
    reloads.set(spec.key, n);
    if (n > MAX_RELOAD) return; // give up quietly — the effect just stays absent
    scene.time.delayedCall(500 * n, () => {
      if (!scene.textures.exists(spec.key)) {
        load(spec);
        scene.load.start();
      }
    });
  });
  scene.load.start();
}

/** Are every spec's textures present yet? (the runtime-load guard). */
export function sheetsReady(scene: Phaser.Scene, specs: SheetSpec[]): boolean {
  return specs.every((s) => scene.textures.exists(s.key));
}

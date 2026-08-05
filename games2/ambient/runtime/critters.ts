import Phaser from "phaser";

// The SCENE-BOUND half of the sprite-art flocks (birds, bats): spritesheet
// loading, per-creature lighting/fog grading, and the shadow decal — everything
// that needs Phaser. The sheet geometry, the 8-facing model and the flap state
// machine are PHASER-FREE and live in ./flap so they can be unit-tested; they
// are re-exported here, so `from "../runtime/critters"` still resolves the whole
// API and no caller had to change.
export * from "./flap";
import { FRAME_W, FRAME_H } from "./flap";

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
  lift: number; // RAW face-lift px — applyShadow draws at the CALLER's current (gx, gy − lift), always a ground line
  shadowA: number; // 0..1 transition alpha multiplier (the elevation cross-fade)
  shadowHide: boolean; // RAW lift > alt: the flyer is below the resolved clifftop — draw no shadow
  shadowDepth: number; // occluder-stable DEPTH to sort the drawn shadow at
  // Fade-OUT phase of an elevation handover: draw the FROZEN departure ground
  // decal instead of the current surface (position must otherwise come from the
  // caller's CURRENT gx/gy — the grade is computed pre-integration, and baking
  // an absolute position here lagged the shadow a frame behind the bird).
  shadowFrozen: boolean;
  frozenX: number;
  frozenY: number;
  frozenD: number;
}

/** Per-creature EASED lighting state (see gradeCritter). Both Bird and Bat carry
 * these fields so the grade can smooth the discrete terrain jump at a cliff.
 * Undefined until the first sample (then snapped, never ramped from black). */
export interface CritterGradeState {
  gl?: [number, number, number]; // eased light multiplier (r,g,b), 0..~N
  gfa?: number; // eased fog alpha, 0..1
  gfc?: [number, number, number]; // eased fog colour (r,g,b), 0..1
  // Shadow elevation CROSS-FADE bookkeeping (see gradeCritter): previous frame's
  // drawn surface + a countdown through the out/in fade phases.
  pLift?: number; // last raw face-lift (jump detector); undefined while hidden
  dLift?: number; // DISPLAYED lift: fast-eased for small (≤LIFT_JUMP) steps, snapped through cross-fades
  pHide?: boolean;
  pX?: number; // last drawn ground point + its depth (the frozen departure decal)
  pSy?: number;
  pDepth?: number;
  fadeT?: number; // transition countdown ms (2·FADE_HALF → 0); 0 = settled
  fx?: number; // frozen departure spot (captured at the handover frame)
  fy?: number;
  fd?: number;
}

// The raw floats __ml.critterLight returns (light multipliers + fog + resolved terrain).
interface CritterProbe {
  l: [number, number, number];
  fog: number;
  fogCol: [number, number, number];
  L: number; // resolved DRAWN terrain level under the ground point (ramps up a face)
  cellL: number; // the resolved column's TOP level (cell.l)
  lift: number; // CONTINUOUS face-lift px: how far gy sits below the column's top LIP (0 on any top/flat)
  shadowDepth: number; // occluder-stable depth to sort the ground shadow at (no per-cell flicker)
}

// Ease time-constants (ms). critterLight now resolves the bird's ground level as
// the DRAWN level up a cliff face (not the wall top), so the raw grade already
// ramps smoothly instead of snapping ~20 levels at a wall. Easing is the safety
// net: it smooths any residual per-frame step (a fast bird stepping 1-2 levels,
// or crossing a cell/occlusion boundary) — the same trick the avatar uses for
// elevation snaps. Fog swings are bigger, so it eases a touch slower than the tint.
const GRADE_TAU = 130;
const FOG_TAU = 165;
const FOG_EPS = 0.01; // "is there real fog?" threshold for the colour track (see gradeCritter)
// Shadow elevation CROSS-FADE. The raw lift keeps the shadow on a GROUND line
// at all times (low ground, or pinned at the resolved column's top lip — see
// critterLight) but HOPS once when the resolve hands over between columns at a
// wall's foot — the elevation change itself. A first cut EASED the position
// through that hop, which dragged the shadow across the WALL FACE (maintainer:
// "freezing on the wall and not on top of the ground tile"). Instead the hop is
// masked by TRANSPARENCY: fade OUT at the frozen departure ground spot, then
// fade IN at the arrival surface — the shadow itself never draws on a wall.
const FADE_HALF = 110; // ms per fade phase (out, then in)
// Fast ease for SMALL (≤LIFT_JUMP) lift changes — 1-level stair snaps and the
// resolve flip-flop of a bird skimming along a terrace edge become a quick
// ≤16px glide instead of a per-frame ±16 flicker. Big changes bypass this (the
// cross-fade masks them), so the shadow never sweeps a tall wall face.
const SMALL_TAU = 60;
// px of single-frame raw-lift change that triggers the cross-fade. Deliberately
// ABOVE one level (16): a 1-level stair hop is small enough to just snap (the
// avatar's shadow does the same on stairs), and fading every step of a
// staircase read as blinking. Only real ≥2-level elevation changes fade.
const LIFT_JUMP = 24;

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
  const snapped = !st.gl || !st.gfc; // first sample / recycled critter → no easing this frame
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
  // Shadow elevation CROSS-FADE. The raw target is always a GROUND point —
  // sy = gy − lift = min(gy, resolved column's lip line) — so within a column
  // the shadow tracks smoothly, and the only discontinuity is the single hop at
  // a column handover (the real elevation change). That hop is masked with
  // transparency, never position-eased (position-easing dragged the shadow
  // across the wall face): fade OUT at the frozen departure ground spot, then
  // fade IN at the arrival surface. A reveal after hidden gets the fade-in half
  // only; a hide/snap/recycle cancels any transition outright.
  const rawLift = p ? p.lift : 0;
  const shadowHide = rawLift > alt;
  const sx = gx;
  const sy = gy - rawLift; // current GROUND line: low ground, or pinned at the column's top lip — never a wall face
  const sd = p ? p.shadowDepth : gy + 3; // RAW occluder-stable depth (gy+3 fallback = old flat behaviour)
  if (snapped || shadowHide) {
    st.fadeT = 0;
    st.dLift = rawLift;
  } else if (st.pHide) {
    st.fadeT = FADE_HALF; // reveal → arrival fade-in only (no stale departure decal)
    st.dLift = rawLift;
  } else if (st.pLift !== undefined && Math.abs(rawLift - st.pLift) > LIFT_JUMP) {
    st.fadeT = FADE_HALF * 2; // column handover → full out+in cross-fade
    st.fx = st.pX; // freeze the departure spot (last frame's drawn ground point)
    st.fy = st.pSy;
    st.fd = st.pDepth;
    st.dLift = rawLift; // position switches instantly UNDER the fade
  } else {
    st.fadeT = Math.max(0, (st.fadeT ?? 0) - dtMs);
    // small step (≤LIFT_JUMP): quick glide — kills the ±1-level flicker of a
    // bird skimming a terrace edge; ≤16px of face sweep for ~60ms, invisible
    const dl = st.dLift ?? rawLift;
    st.dLift = dl + (rawLift - dl) * (1 - Math.exp(-dtMs / SMALL_TAU));
  }
  const ft = st.fadeT ?? 0;
  const outPhase = ft > FADE_HALF && st.fx !== undefined;
  st.pHide = shadowHide;
  if (!shadowHide) {
    st.pLift = rawLift;
    st.pX = sx;
    st.pSy = gy - (st.dLift ?? rawLift); // the drawn line (displayed lift) — the frozen decal must match what was on screen
    st.pDepth = sd;
  } else st.pLift = undefined;
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return {
    tint: (ch(st.gl[0]) << 16) | (ch(st.gl[1]) << 8) | ch(st.gl[2]),
    fog: st.gfa ?? 0,
    fogTint: (ch(st.gfc[0]) << 16) | (ch(st.gfc[1]) << 8) | ch(st.gfc[2]),
    lift: st.dLift ?? rawLift,
    shadowDepth: sd,
    shadowA: ft <= 0 ? 1 : outPhase ? (ft - FADE_HALF) / FADE_HALF : 1 - ft / FADE_HALF,
    shadowHide,
    shadowFrozen: outPhase,
    frozenX: outPhase ? st.fx! : 0,
    frozenY: outPhase ? st.fy! : 0,
    frozenD: outPhase ? st.fd! : 0,
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
 * SURFACE vs FACE — mirrors the game's own avatar/monster shadow (WorldScene
 * lands the shadow at flatY − groundElev but SORTS it at the flat-y basis so a
 * wall in front still occludes it). critterLight resolves the FRONT-MOST DRAWN
 * surface at (gx,gy), which gives the identity flatY == gy + groundL*LEVEL_PX
 * (i.e. gy = flatY − drawnLevel*lh). Two consequences:
 *  • DEPTH is `shadowDepth`, computed by critterLight against the DISCRETE per-cell
 *    terrain occluders so it can't blink: any resolved elevated column sorts at the
 *    resolved cell's anchor + 3*dy + 0.25 (clears its own images, the cardinal
 *    fronts AND the front-diagonal whose diamond apex the shadow straddles — the
 *    naive continuous-gy depth swung behind covering tiles = the flicker); flat
 *    level-0 keeps `gy + 3`. A genuinely taller wall in front still out-sorts
 *    and hides it.
 *  • POSITION is the caller's CURRENT (gx, gy − grade.lift) — ALWAYS a ground
 *    line (low ground, or pinned at the column's top lip), never a wall face —
 *    or the frozen departure decal while grade.shadowFrozen. Current-coords on
 *    purpose: the grade is computed pre-integration, so baking an absolute
 *    position into it lagged the shadow a frame behind the bird. Elevation
 *    handovers are masked by `grade.shadowA` — a transparency CROSS-FADE (out at
 *    the departure ground spot, in at the arrival) instead of a position glide,
 *    which dragged the shadow across the wall (maintainer).
 * `grade.shadowHide` (RAW lift > alt: the flyer is below the resolved clifftop,
 * cruising in FRONT of the wall) draws nothing — never a wall shadow, never a
 * shadow floating above its own sprite. Created lazily; caller destroys it. */
export function applyShadow(
  scene: Phaser.Scene,
  holder: { shadow?: Phaser.GameObjects.Image },
  gx: number,
  gy: number,
  alt: number,
  grade: CritterGrade,
): void {
  ensureCritterShadow(scene);
  const f = Math.min(1, Math.max(0, alt / 130)); // 0 on the ground → 1 at high cruise
  let s = holder.shadow;
  if (!s) {
    s = scene.add.image(gx, gy, SHADOW_KEY).setOrigin(0.5, 0.5);
    holder.shadow = s;
  }
  if (grade.shadowHide) {
    s.setVisible(false);
    return;
  }
  s.setPosition(grade.shadowFrozen ? grade.frozenX : gx, grade.shadowFrozen ? grade.frozenY : gy - grade.lift)
    .setDepth(grade.shadowFrozen ? grade.frozenD : grade.shadowDepth) // occluder-STABLE (discrete per cell) so it can't blink behind a front tile
    .setDisplaySize(16 - f * 6, 6.4 - f * 2.6) // much smaller than the player's ~34×14
    .setAlpha((0.58 - f * 0.24) * grade.shadowA) // base look × the elevation cross-fade
    .setVisible(grade.shadowA > 0.02);
  // QA probe state (birds debug .all): frozen-decal phase + fade fraction.
  s.setData("fz", grade.shadowFrozen).setData("fa", grade.shadowA);
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

/* PRECIPITATION — the pure half. No Phaser, no DOM.
 *
 * The per-weather table and every piece of arithmetic a drop obeys, so
 * `server/test/weather.test.ts` can pin them and `layer.ts` only pools
 * sprites and reads the clock. Ported from client/src/weatherfx.ts
 * (maintainer 2026-09-17: weather is ambient's now) with the numbers
 * unchanged — the move must not restyle the rain.
 *
 * WHAT A WEATHER IS, at this scale: a POOLED SHEET of world-space particles
 * that RECYCLE. A drop that reaches its landing height pops a ripple and
 * returns to the top band; x wraps sideways. Density is held constant against
 * the camera's area, so zooming does not thin the rain, and nothing has a
 * lifespan that could pop.
 *
 * THE SIX ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION: each is keyed to one index
 * of the shared WEATHER_NAMES, and the world has exactly one weather index at
 * a time. The `conflicts` lists in weather.ts are the second lock, for MANUAL
 * mode, where a player could otherwise switch two on by hand.
 */

/** A pooled particle's kind of life. */
export type PrecipKind = "rain" | "snow" | "leaf";

export interface Cfg {
  /** Weather index in the shared WEATHER_NAMES. */
  idx: number;
  /** Stable ambient feature name (also the settings row's id). */
  name: string;
  /** Drops on screen at the REFERENCE view area. */
  count: number;
  vy: [number, number];
  /** Base horizontal drift, world px/s; negative blows left. */
  vx: number;
  alpha: number;
  /** Streak length multiplier. */
  scaleY: number;
  kind: PrecipKind;
  /** A shared sine on the horizontal velocity — every streak leans together,
   *  which sells wind far better than per-drop noise. */
  gust: boolean;
  /** Camera-flash lightning, with the composer's thunder in sync. */
  lightning: boolean;
  /** The drop LANDS and pops a ripple. */
  splash: boolean;
}

/* The table, verbatim from weatherfx.ts. Order is WEATHER_NAMES order. */
export const PRECIP: readonly Cfg[] = [
  { idx: 3, name: "drizzle",   count: 90,  vy: [300, 390], vx: -15,  alpha: 0.34, scaleY: 0.6,  kind: "rain", gust: false, lightning: false, splash: true },
  { idx: 4, name: "rain",      count: 260, vy: [620, 760], vx: -70,  alpha: 0.45, scaleY: 1,    kind: "rain", gust: false, lightning: false, splash: true },
  { idx: 5, name: "heavyrain", count: 520, vy: [700, 880], vx: -120, alpha: 0.52, scaleY: 1.25, kind: "rain", gust: false, lightning: false, splash: true },
  { idx: 6, name: "storm",     count: 660, vy: [760, 960], vx: -250, alpha: 0.56, scaleY: 1.4,  kind: "rain", gust: true,  lightning: true,  splash: true },
  { idx: 7, name: "snow",      count: 240, vy: [55, 95],   vx: 0,    alpha: 0.9,  scaleY: 1,    kind: "snow", gust: false, lightning: false, splash: false },
  { idx: 8, name: "windy",     count: 110, vy: [15, 60],   vx: -200, alpha: 0.95, scaleY: 1,    kind: "leaf", gust: true,  lightning: false, splash: false },
];

export const cfgByIdx = (idx: number): Cfg | null => PRECIP.find((c) => c.idx === idx) ?? null;
export const cfgByName = (name: string): Cfg | null => PRECIP.find((c) => c.name === name) ?? null;

/** World px² the counts are tuned for. */
export const REF_AREA = 520 * 700;
export const MARGIN = 60;
/** BELOW the darkness overlay on purpose (NOT the 900_000.x ambient band):
 *  that is what makes rain dim with the night and take torchlight, and puts a
 *  character in FRONT of the sheet. */
export const DEPTH = 899_500;
export const SPLASH_DEPTH = 899_490;
export const MAX_SPLASH = 130;
export const SPLASH_LIFE: [number, number] = [300, 480];
/** Ms a landed flake sits before it melts, and the fade. */
export const SNOW_REST: [number, number] = [2500, 6000];
export const SNOW_FADE = 1500;
/** Snow does not settle on water — it goes in an instant. */
export const SNOW_WATER_MELT = 320;
/** The intensity roll, seconds: a weather fades its density in, never pops. */
export const SHOWN_TAU_S = 4;
/** Hard ceiling on live particles whatever the zoom asks for. */
export const MAX_DROPS = 2000;
/** Every Nth Windy slot is a faint wind motion-line rather than a leaf. */
export const WISP_EVERY = 7;
export const WISP_ALPHA = 0.13;
export const LEAF_TINTS = [0x7da05a, 0xa5854f, 0x5f8a4e] as const;

/** Density against the camera's area, capped so a zoomed-out view cannot ask
 *  for an unbounded sheet. */
export function areaScale(viewW: number, viewH: number): number {
  return Math.min(3, (viewW * viewH) / REF_AREA);
}

/** How many particles this weather wants for this view. */
export function targetCount(cfg: Cfg | null, viewW: number, viewH: number): number {
  return cfg ? cfg.count * areaScale(viewW, viewH) : 0;
}

/** Ease the shown count toward the target on the weather roll. */
export function easeShown(shown: number, target: number, dtMs: number): number {
  return shown + (target - shown) * (1 - Math.exp(-(dtMs / 1000) / SHOWN_TAU_S));
}

/** The shared gust multiplier at time t (seconds) — one number every streak
 *  leans by, which is the whole trick. */
export function gustAt(t: number, on: boolean): number {
  return on ? 0.65 + 0.55 * Math.sin(t * 0.45) + 0.2 * Math.sin(t * 1.7) : 1;
}

/** Streak rotation: rain tilts into its own fall, snow and leaves never do. */
export function streakRot(cfg: Cfg, vxBase: number): number {
  if (cfg.kind !== "rain") return 0;
  return Math.atan2(-vxBase, cfg.vy[0] + (cfg.vy[1] - cfg.vy[0]) / 2);
}

/** A splash ripple's scale and alpha at age/life — an iso ground ellipse, so
 *  y is half of x. */
export function splashAt(p: number, grow: number): { sx: number; sy: number; a: number } {
  const sc = 0.35 + p * grow;
  return { sx: sc, sy: sc * 0.5, a: (1 - p) * 0.7 };
}

/** Snow's per-flake twinkle while falling. */
export function snowTwinkle(t: number, phase: number): number {
  return 0.75 + 0.25 * Math.sin(t * 2 + phase);
}

export const SNOW_FALLING = 0;
export const SNOW_RESTING = 1;
export const SNOW_MELTING = 2;

/** What a flake that just touched down should do. On water it skips the rest
 *  entirely and fades fast where it touched — snow does not lie on a lake.
 *  `onWater` comes from the HARM-AWARE probe (runtime/water.ts): the raw game
 *  probe calls LAVA water, which had rain rippling on molten rock. */
export function snowLanding(onWater: boolean, rnd: () => number): { state: number; dur: number } {
  if (onWater) return { state: SNOW_MELTING, dur: SNOW_WATER_MELT };
  return { state: SNOW_RESTING, dur: SNOW_REST[0] + rnd() * (SNOW_REST[1] - SNOW_REST[0]) };
}

/** Deterministic visual RNG — no Math.random in the hot path. */
export function makeRand(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

import { WEATHER_UNIVERSE, conflictsOf } from "@nangijala/shared";

/* THE EXCLUSION RULE IS THE MATRIX (matrix.ts), applied here over the whole
 * weather universe — the eight weather effects plus thunder — so a feature's
 * `conflicts` and the server's roller read the same rule.
 *
 * (Was: "each conflicts with the other five." That was the flat first cut, so it is the same
 * object the features are built from AND the thing the unit test can read
 * without dragging Phaser and the composer into node. `weather.ts` maps these
 * straight onto its AmbientFeatures — the descriptor IS the source of truth
 * for a weather's name and what it may not run with. */
export interface WeatherDescriptor {
  name: string;
  idx: number;
  /** Every OTHER precipitation. Declared one-directionally; the runtime makes
   *  it symmetric (runtime/types.ts conflictClosure). */
  conflicts: string[];
  cfg: Cfg;
}

export function weatherDescriptors(): WeatherDescriptor[] {
  return PRECIP.map((cfg) => ({
    name: cfg.name,
    idx: cfg.idx,
    conflicts: conflictsOf(cfg.name, WEATHER_UNIVERSE),
    cfg,
  }));
}

/* LAVA — the pure half. No Phaser, no DOM: what one bubble does between
 * swelling and bursting, and what one ash mote does on its way up, are
 * arithmetic here so `server/test/lava.test.ts` can pin them, and lava.ts only
 * pools sprites and reads the clock.
 *
 * A LAVA BUBBLE IS NOT A WATER BUBBLE. Water bubbles are quick, round and
 * many; molten rock is viscous, so one dome swells for the better part of a
 * second, HOLDS while its skin stretches, and then bursts. The slowness is the
 * whole read: a fast bubble on lava looks like boiling soup.
 *
 * AND IT IS SEEN IN BOTH DIRECTIONS. The surface it sits on is the brightest
 * thing in the picture (`#fd5a02`), so a mark that is merely "orange" vanishes
 * into it — the smoke's lesson, paid again. The DOME is hotter than the pool
 * (thin stretched skin over the fire beneath, so it goes toward yellow-white)
 * and the CRUST left after the burst is cooler and darker. One effect, two
 * departures from the background, and neither can be lost in it.
 *
 * ASH STAYS IN THE GLOW. A dark mote is legible against bright lava and
 * invisible against the rock above it, so ash lives a short life and fades out
 * well before it leaves the pool's own light. That is also what ash off a lava
 * pond actually does — it is not a chimney.
 */

/** One vent's cycle: the gap from one burst to the next, jittered so two
 *  vents in a pool never pop together. */
export const PERIOD: [number, number] = [2600, 7000];
export const PERIOD_JITTER = 0.3;
/** The dome swells, then HOLDS while its skin stretches, then bursts. */
export const SWELL_MS: [number, number] = [700, 1400];
export const HOLD_MS: [number, number] = [120, 420];
/** The burst itself, and the dark crust ring that spreads from it. */
export const POP_MS = 220;
export const CRUST_MS = 900;
export const CRUST_R0 = 2;
export const CRUST_RMAX = 7;
/** Sparks thrown by the burst: few, and they fall back into the pool. */
export const SPARK_N = 3;
export const SPARK_MS = 520;

/** Ash: slow, short-lived, and it never leaves the pool's own glow. */
export const ASH_LIFE: [number, number] = [900, 1800];
export const ASH_RISE: [number, number] = [9, 17]; // px/s
export const ASH_REACH = 26; // px — the ceiling the fade is shaped around
export const ASH_DRIFT = 42 * 0.14; // the cloud wind's heading, a small share
export const ASH_SWAY: [number, number] = [1.5, 3.5];
export const ASH_HZ: [number, number] = [0.3, 0.7];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** IS THIS LAVA? The surface table is the authority and `harm` is the field
 *  that means it: lava is the game's one harmful liquid (4 HP/s while you swim
 *  in it) and the comment beside it says making a second one is a maintainer's
 *  call, one field away. So this asks the question the table answers —
 *  "does this liquid burn" — rather than matching a ground name, and a second
 *  molten liquid would bubble on the day it is added, with no edit here. */
export function isLava(s: { swimmable?: boolean; harm?: number } | null | undefined): boolean {
  return !!s && s.swimmable === true && typeof s.harm === "number" && s.harm > 0;
}

/** The dome's radius in whole px at `age` ms into the swell: it grows fast at
 *  first and then strains, which is what reads as viscous. */
export function domeR(age: number, swell: number): number {
  const t = clamp01(age / Math.max(1, swell));
  return Math.max(1, Math.round(1 + 2 * Math.pow(t, 0.6)));
}

/** ...and its opacity, which rises with it and holds at full while the skin
 *  stretches. Never switched on: at age 0 there is nothing there. */
export function domeAlpha(age: number, swell: number, hold: number): number {
  if (age < 0) return 0;
  if (age >= swell + hold) return 0;
  if (age >= swell) return 1;
  return Math.pow(clamp01(age / swell), 0.8);
}

/** The burst: full the instant the skin goes, gone in POP_MS. */
export function popAlpha(age: number): number {
  if (age < 0 || age >= POP_MS) return 0;
  return Math.pow(1 - age / POP_MS, 0.7);
}

/** The crust ring left behind, spreading and fading — whole-pixel radii, and
 *  it is DARKER than the pool, which is the other half of reading against a
 *  bright surface. */
export function crustR(age: number): number {
  const t = clamp01(age / CRUST_MS);
  return Math.max(CRUST_R0, Math.round(CRUST_R0 + (CRUST_RMAX - CRUST_R0) * Math.pow(t, 0.55)));
}

export function crustAlpha(age: number): number {
  if (age < 0 || age >= CRUST_MS) return 0;
  const t = age / CRUST_MS;
  return Math.min(1, t / 0.1) * Math.pow(1 - t, 1.3);
}

/** One spark from the burst: thrown up and out, pulled back down into the
 *  pool. Whole pixels, so it hops rather than glides. */
export function sparkAt(i: number, age: number): { dx: number; dy: number; alive: boolean } {
  if (age < 0 || age >= SPARK_MS) return { dx: 0, dy: 0, alive: false };
  const t = age / SPARK_MS;
  const side = i % 2 === 0 ? 1 : -1;
  const reach = (1 + Math.floor(i / 2)) * 2.4 * side;
  const up = 7 - Math.abs(reach) * 0.35;
  return {
    dx: Math.round(reach * t * 1.8),
    // up, then back down into the lava: a parabola that ENDS at the surface
    dy: -Math.round(up * 4 * t * (1 - t)),
    alive: true,
  };
}

/** Ms until this vent bursts again. */
export function nextPeriod(rnd: () => number): number {
  const base = PERIOD[0] + rnd() * (PERIOD[1] - PERIOD[0]);
  return Math.round(base * (1 + (rnd() * 2 - 1) * PERIOD_JITTER));
}

/** The phases of one vent's cycle, from the start of its swell. */
export function timeline(swell: number, hold: number, period: number) {
  const popAt = swell + hold;
  const doneAt = popAt + Math.max(POP_MS, CRUST_MS, SPARK_MS);
  return { popAt, doneAt, nextAt: Math.max(doneAt, popAt + period) };
}

export type Phase = "swell" | "pop" | "wait";

export function phaseAt(t: number, tl: ReturnType<typeof timeline>): Phase {
  if (t < tl.popAt) return "swell";
  if (t < tl.doneAt) return "pop";
  return "wait";
}

/* ---- ash ------------------------------------------------------------------ */

/** How high a mote has risen after `age` ms. Slow and slowing: ash off a pond
 *  drifts, it does not climb. */
export function ashY(age: number, life: number, up: number): number {
  const t = clamp01(age / life);
  return (up * Math.max(0, age)) / 1000 * (1 - 0.35 * t);
}

/** Sideways: the cloud wind plus its own slow sway. */
export function ashX(age: number, sway: number, phase: number, hz: number): number {
  const s = Math.max(0, age) / 1000;
  return ASH_DRIFT * s + Math.sin(phase + s * hz * Math.PI * 2) * sway;
}

/** A mote thickens out of the pool and is gone BEFORE it leaves the glow: past
 *  ASH_REACH there is nothing bright behind it and a dark speck on dark rock
 *  cannot be seen (the smoke's rule — the value is chosen for the background
 *  it will actually be drawn against). */
export function ashAlpha(age: number, life: number, up: number): number {
  if (age < 0 || age >= life) return 0;
  const t = age / life;
  const inn = Math.min(1, t / 0.15);
  const height = ashY(age, life, up);
  const nearGlow = clamp01(1 - height / ASH_REACH);
  return inn * Math.pow(1 - t, 1.1) * nearGlow;
}

/* ---- colour --------------------------------------------------------------- */

const ch = (c: number, sh: number) => (c >> sh) & 255;

/** Mix two packed RGB colours. */
export function mix(a: number, b: number, k: number): number {
  const t = clamp01(k);
  const m = (sh: number) => Math.round(ch(a, sh) + (ch(b, sh) - ch(a, sh)) * t) & 255;
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** The white-hot the dome strains toward — a yellow-white, not a pure white:
 *  molten rock never looks blue. */
export const HOT = 0xffeab4;

/** The dome's colour: the pool's own, pushed toward white-hot as it stretches.
 *  THE POOL'S COLOUR IS READ FROM THE TILES DOMAIN (`ground_types.json`
 *  `lava.palette.top`), never assumed — the same seam `foam/` uses, so a
 *  recoloured lava recolours its bubbles with no edit here. */
export function domeTint(lava: number, t: number): number {
  return mix(lava, HOT, 0.35 + 0.45 * clamp01(t));
}

/** ...and the crust's: the pool's own wall colour, the cooled skin the tiles
 *  domain already publishes beside the top one. */
export function crustTint(wall: number): number {
  return wall;
}

/** Ash is nearly black, and never pale: the crawlers' rule. It is seen because
 *  the lava behind it is the brightest thing on the screen. */
export const ASH = 0x231a16;

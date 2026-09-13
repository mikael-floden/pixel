/* FIRE SMOKE — the pure half. No Phaser, no DOM: what a puff of smoke does
 * between leaving the flame and thinning away is arithmetic here so
 * `server/test/smoke.test.ts` can pin it, and smoke.ts only pools sprites and
 * reads the clock.
 *
 * WHAT SMOKE IS AT THIS SCALE. Not a cloud — a COLUMN. One puff is one or two
 * pixels and the eye never sees it as smoke; what says "that is burning" is a
 * thin line of marks leaving the same point, leaning the same way, thinning as
 * it climbs. So the puffs are emitted fast enough to read as a continuous
 * ribbon, and everything that shapes them (rise, curl, spread, fade) is a
 * function of ONE puff's age.
 *
 * IT RISES FAST AND GIVES UP. Hot gas leaves a flame quickly on its own
 * buoyancy and slows as it cools and mixes — the same shape as the embers'
 * spark, which is the physics both share. A puff that climbed at a constant
 * rate read as a floating dot.
 *
 * IT CURLS, WHICH IS THE WHOLE LOOK (maintainer 2026-09-13: "thin grey wisps
 * CURLING up from open flames"). A straight column reads as a post. Each puff
 * carries its own phase into a slow sine, and because neighbours in the column
 * are close together in phase, the ribbon bends as one rather than scattering.
 *
 * AND IT SPREADS. The column is tight at the flame and loose at the top: real
 * smoke entrains air as it rises. The spread grows with age, which is also
 * what keeps a long-lived puff from tracing the same line as its neighbour.
 */

/** How long one puff is in the air. Long enough to climb clear of the piece. */
export const PUFF_LIFE: [number, number] = [1800, 3200];
/** Rise in px/s AT THE FLAME, and the share of that still left at the end. */
export const RISE0: [number, number] = [22, 34];
export const RISE_DRAG = 0.35;
/** The curl: how far a puff wanders sideways, and how fast it swings. */
export const CURL_PX: [number, number] = [2.5, 6];
export const CURL_HZ: [number, number] = [0.25, 0.55];
/** How wide the column gets by the end of a puff's life, in px either side. */
export const SPREAD_PX = 4;
/** THE CLOUD LAYER'S WIND, the same heading the pollen and the leaves drift on
 *  (~42, 23 px/s in the weather shader). Smoke takes a modest share of it —
 *  it is a column leaning, not a plume blown flat — and far less of the
 *  vertical, because down-screen motion fights the rise that makes it read. */
export const WIND_X = 42 * 0.22;
export const WIND_Y = 23 * 0.1;
/** Gap between puffs from one fire. Short: the column has to read as a line,
 *  not a string of beads. */
export const GAP_MS: [number, number] = [95, 170];
/** The most puffs one fire keeps in the air, and the ceiling over all fires. */
export const PER_FIRE = 16;
export const MAX_PUFFS = 64;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** DOES THIS LIGHT SMOKE? The scenery domain publishes a light KIND, so this
 *  is a question about data rather than a guess from a name or a colour
 *  (`fire/open` 63 pieces, `fire/ember` 19, `fire/enclosed` 60, plus 355
 *  `glow/*` that are not fire at all).
 *
 *  A FIRE THAT IS OPEN TO THE AIR SMOKES. That is every `fire/` kind except
 *  `fire/enclosed` — a lantern's flame is behind glass, and the maintainer
 *  asked for "open flames". Embers are IN: a bed of coals is the smokiest
 *  thing in the game, and it is a fire whether or not it still has a flame.
 *
 *  Keyed on the KIND and not on the published `embers` boolean, even though
 *  the two pick the same 82 pieces today: that flag means "throws sparks",
 *  which is a different question, and a smouldering kiln that sparks nothing
 *  must still smoke. */
export function smokes(kind: string | null | undefined): boolean {
  return typeof kind === "string" && kind.startsWith("fire/") && kind !== "fire/enclosed";
}

/** How high a puff has climbed after `age` ms, in px above the flame. Fast at
 *  the flame, slowing as it cools — the integral of a linearly decaying rise,
 *  so it is smooth rather than a two-part curve. */
export function riseY(age: number, life: number, up: number): number {
  const t = clamp01(age / life);
  const s = Math.max(0, age) / 1000;
  return up * s * (1 - (1 - RISE_DRAG) * t * 0.5);
}

/** Sideways offset after `age` ms: the wind carries it, the curl bends it, and
 *  the spread widens with age. `curl` is the puff's own amplitude and `phase`
 *  its place in the swing, so neighbours bend together. */
export function driftX(age: number, curl: number, phase: number, hz: number, spread: number): number {
  const s = Math.max(0, age) / 1000;
  return WIND_X * s + Math.sin(phase + s * hz * Math.PI * 2) * curl + spread * s * 0.5;
}

/** ...and the small down-screen component of the same wind. The rise always
 *  wins; this only tilts the column. */
export function driftY(age: number): number {
  return WIND_Y * (Math.max(0, age) / 1000);
}

/** A puff's opacity: it THICKENS out of the flame over its first breath (smoke
 *  is not there and then is), holds briefly, then thins away to nothing. Never
 *  switched off — the folder's standing rule, and the one thing that makes a
 *  column read as smoke rather than as dots winking out. */
export function puffAlpha(age: number, life: number): number {
  if (age < 0 || age >= life) return 0;
  const t = age / life;
  const inn = Math.min(1, t / 0.12);
  return inn * Math.pow(1 - t, 1.15);
}

/** How big the mark is: smoke gathers as it rises and then falls apart, so a
 *  puff grows from one pixel to three and drops back to one as it thins. */
export function puffSize(age: number, life: number): 1 | 2 | 3 {
  const t = clamp01(age / life);
  if (t < 0.12) return 1;
  if (t > 0.82) return 1;
  return t < 0.4 ? 2 : 3;
}

/** Ms until this fire lets go of the next puff. */
export function nextGap(rnd: () => number): number {
  return GAP_MS[0] + rnd() * (GAP_MS[1] - GAP_MS[0]);
}

/** THE GREY, AND IT GETS DARKER IN DAYLIGHT — which is the opposite of the
 *  first cut and the whole reason this effect exists.
 *
 *  Smoke has no colour of its own worth drawing: a warm tint read as dust and
 *  a blue one as mist, and anything with real saturation breaks the background
 *  law the butterflies established. So it is a neutral grey.
 *
 *  WHICH grey is decided by what it is drawn AGAINST, not by what smoke "is".
 *  44 of the 51 open fires in the_game stand in the open, so the case the
 *  maintainer asked for is a fire on sunlit ground — and a PALE grey over lit
 *  terrain is nothing at all: measured at a brazier, a 150-grey wisp moved its
 *  own pixels by 5.8 luma, which is the embers' "technically visible is not
 *  visible" in a new costume. A real plume against a bright day is DARK. So
 *  the tint runs from a mid grey at night (where the ground is dark and the
 *  effect is mostly off anyway) to a dark one at noon. */
export function smokeTint(sun: number): number {
  const v = Math.round(112 - 40 * clamp01(sun)); // 112 at night, 72 in full sun
  return (v << 16) | (v << 8) | v;
}

/** The feature's own likeliness, before the outdoor gain. Smoke is the DAY
 *  case by design — a grey wisp at midnight is fog, not fire — but it never
 *  switches off, because a fire burns all night. */
export function weight(sun: number): number {
  return 0.3 + 0.7 * clamp01(sun);
}

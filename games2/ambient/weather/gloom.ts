/* WEATHER'S GRIP ON THE LIGHT — the half of weather that is not particles.
 *
 * Three eased scalars grade the world while weather runs: how CLOUDED the sky
 * is (greys the ambient toward its own mean), how much flat GLOOM the
 * precipitation adds (scales the ambient down), and whether the MIST banks are
 * up. Ambient's numbers (maintainer 2026-09-17, full ownership of weather),
 * keyed since 2026-09-18 by WHICH WEATHER EFFECTS ARE ACTIVE — there is no
 * weather index any more; weather is ordinary ambient effects the server
 * switches on per zone, and cloud cover can now sit under rain the way a real
 * sky does.
 *
 * WHY THIS IS A PURE MODULE THAT WORLDSCENE CALLS, and not something a feature
 * publishes: these feed `ambOut`, the NIGHT SHADER's ambient. If the lighting
 * read them off a registered feature, a player switching "Rain" off in
 * Settings would BRIGHTEN THE WORLD mid-storm. So ambient owns the numbers
 * and the renderer owns the dependency: WorldScene imports `easeGloom` and
 * calls it every frame. One owner, no optionality.
 *
 * The per-effect values are the old per-index table, one row per name, and
 * the ~4 s roll is unchanged, so a single active weather grades exactly as it
 * did; the test pins that. Several at once take the STRONGEST of each term —
 * cloud under rain is the rain's cloud, not the sum.
 */

/** Cloud cover each weather effect brings (0 clear … 1 overcast). */
export const CLOUD_OF: Readonly<Record<string, number>> = {
  cloudy: 1, drizzle: 0.35, rain: 0.7, heavyrain: 1, storm: 1, snow: 0.4, windy: 0.25,
};
/** Flat gloom each precipitation adds on top of the cloud grey. */
export const DIM_OF: Readonly<Record<string, number>> = {
  drizzle: 0.05, rain: 0.12, heavyrain: 0.22, storm: 0.34, snow: 0.05,
};
/** The one effect that raises mist banks. */
export const MIST_EFFECT = "mist";
/** Seconds of the easing roll — the same ~4s the cloud cover always used. */
export const GLOOM_TAU_S = 4;
/** Closer than this to the target and cloud/mist SNAP, so a scalar the shader
 *  reads never creeps forever in the last thousandth. */
export const GLOOM_SNAP = 0.005;

export interface Gloom {
  cloud: number;
  dim: number;
  mist: number;
}

export function newGloom(): Gloom {
  return { cloud: 0, dim: 0, mist: 0 };
}

/* ROWS A PLAYER FORCED ON, unioned with the server's set by every grade below.
 *
 * A weather row switched on in Settings (manual mode) must show its WHOLE
 * effect, and for `cloudy` and `mist` the gloom IS the whole effect: for two
 * days their rows were switches wired to nothing — `setForced` wrote a set only
 * the precipitation features read, while this module read the server's set
 * alone — so the maintainer's favourite effect could not be seen at all
 * (2026-09-19: "the mist effect was created by me and is the best looking
 * effect this game has"; no zone assigned it either, see ambientreach.test).
 *
 * A UNION, so the law above still holds: switching a row OFF only removes the
 * force, never what the server rolled — a Settings switch can still not
 * brighten a storm the world is in. Held here and not passed in, because the
 * caller is WorldScene and this stays ambient's to own. */
const forced = new Set<string>();

/** Force a weather row's grade on (Settings, manual mode) or release it. */
export function forceGloom(name: string, on: boolean): void {
  if (on) forced.add(name);
  else forced.delete(name);
}

/** The forced rows, for the probe and the tests. */
export function forcedGloom(): string[] {
  return [...forced].sort();
}

/** What this active set grades to, with no easing — the join/teleport snap.
 *  The forced rows are graded with it. */
export function gloomTarget(active: Iterable<string>): Gloom {
  let cloud = 0, dim = 0, mist = 0;
  const grade = (n: string) => {
    cloud = Math.max(cloud, CLOUD_OF[n] ?? 0);
    dim = Math.max(dim, DIM_OF[n] ?? 0);
    if (n === MIST_EFFECT) mist = 1;
  };
  for (const n of active) grade(n);
  for (const n of forced) grade(n);
  return { cloud, dim, mist };
}

/** Roll `g` toward this active set over dt. Mutates and returns it.
 *
 *  `cloud` and `mist` snap inside GLOOM_SNAP; `dim` deliberately does NOT,
 *  which is how WorldScene had it — it is the term multiplying the whole
 *  ambient, and a snap there is a visible step in a dark scene. */
export function easeGloom(g: Gloom, active: Iterable<string>, dtMs: number): Gloom {
  const t = gloomTarget(active);
  const k = 1 - Math.exp(-(dtMs / 1000) / GLOOM_TAU_S);
  g.cloud += (t.cloud - g.cloud) * k;
  if (Math.abs(g.cloud - t.cloud) < GLOOM_SNAP) g.cloud = t.cloud;
  g.mist += (t.mist - g.mist) * k;
  if (Math.abs(g.mist - t.mist) < GLOOM_SNAP) g.mist = t.mist;
  g.dim += (t.dim - g.dim) * k;
  return g;
}

/** Jump straight to the set's grade (a join, or a teleport). */
export function snapGloom(g: Gloom, active: Iterable<string>): Gloom {
  const t = gloomTarget(active);
  g.cloud = t.cloud;
  g.dim = t.dim;
  g.mist = t.mist;
  return g;
}

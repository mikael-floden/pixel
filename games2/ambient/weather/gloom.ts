/* WEATHER'S GRIP ON THE LIGHT — the half of weather that is not particles.
 *
 * Three eased scalars grade the world while the weather runs: how CLOUDED the
 * sky is (greys the ambient toward its own mean), how much flat GLOOM the
 * precipitation adds (scales the ambient down), and whether the MIST banks are
 * up. They were eased inside WorldScene's lighting block; they are ambient's
 * now, because weather is ambient's (maintainer 2026-09-17, "I give you full
 * rights to change the game so you have full control over the whether
 * effects!").
 *
 * WHY THIS IS A PURE MODULE THAT WORLDSCENE CALLS, and not something a feature
 * publishes: these feed `ambOut`, which is the NIGHT SHADER's ambient. If the
 * lighting read them from a registered ambient feature, then switching the
 * "Rain" effect off in Settings would BRIGHTEN THE WORLD in the middle of a
 * storm — world lighting would depend on an optional cosmetic subsystem, and a
 * toggle meant to stop some sprites would silently regrade the game. So
 * ambient owns the numbers (this file) and the renderer owns the dependency:
 * WorldScene imports `easeGloom` and calls it every frame, exactly as hard a
 * dependency as the table it used to hold inline. One owner, no optionality.
 *
 * The values and the ~4s roll are carried over unchanged from WorldScene, so
 * this move is not allowed to alter a single frame of lighting; the test pins
 * the tables and the ease against the old constants.
 */

/** How clouded each weather is (0 clear … 1 overcast). */
export const WEATHER_CLOUD: Readonly<Record<number, number>> = {
  1: 1, 3: 0.35, 4: 0.7, 5: 1, 6: 1, 7: 0.4, 8: 0.25,
};
/** Flat gloom each PRECIPITATION adds on top of the cloud grey. */
export const WEATHER_DIM: Readonly<Record<number, number>> = {
  3: 0.05, 4: 0.12, 5: 0.22, 6: 0.34, 7: 0.05,
};
/** The one weather that raises mist banks. */
export const WEATHER_MIST_IDX = 2;
/** Seconds of the easing roll — the same ~4s the cloud cover always used, so
 *  a weather change drifts in rather than popping. */
export const GLOOM_TAU_S = 4;
/** Closer than this to the target and the ease SNAPS, so a scalar the shader
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

/** What this weather grades to, with no easing — the join/teleport snap. */
export function gloomTarget(weatherIdx: number): Gloom {
  return {
    cloud: WEATHER_CLOUD[weatherIdx] ?? 0,
    dim: WEATHER_DIM[weatherIdx] ?? 0,
    mist: weatherIdx === WEATHER_MIST_IDX ? 1 : 0,
  };
}

/** Roll `g` toward this weather over dt. Mutates and returns it, because the
 *  caller holds one per scene and this runs every frame.
 *
 *  `cloud` and `mist` snap inside GLOOM_SNAP; `dim` deliberately does NOT,
 *  which is how WorldScene had it — it is the term multiplying the whole
 *  ambient, and a snap there is a visible step in a dark scene. */
export function easeGloom(g: Gloom, weatherIdx: number, dtMs: number): Gloom {
  const t = gloomTarget(weatherIdx);
  const k = 1 - Math.exp(-(dtMs / 1000) / GLOOM_TAU_S);
  g.cloud += (t.cloud - g.cloud) * k;
  if (Math.abs(g.cloud - t.cloud) < GLOOM_SNAP) g.cloud = t.cloud;
  g.mist += (t.mist - g.mist) * k;
  if (Math.abs(g.mist - t.mist) < GLOOM_SNAP) g.mist = t.mist;
  g.dim += (t.dim - g.dim) * k;
  return g;
}

/** Jump straight to the weather's grade (a join, or a teleport — WorldScene
 *  did this in two places so a player never eases in from clear sky). */
export function snapGloom(g: Gloom, weatherIdx: number): Gloom {
  const t = gloomTarget(weatherIdx);
  g.cloud = t.cloud;
  g.dim = t.dim;
  g.mist = t.mist;
  return g;
}

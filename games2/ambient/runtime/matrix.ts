/* (ambient/runtime — shared by features and the server; features may not
 * import each other, so this is not under weather/.)
 *
 * WHICH AMBIENT EFFECTS MAY RUN TOGETHER, AND HOW OFTEN EACH SHOULD — the
 * pure data the SERVER rolls from and the client's toggles enforce.
 *
 * Maintainer 2026-09-18: "All ambient effects will be controlled by the
 * server in order to maintain the % of time that ambient effect should be
 * active in a zone ... Weather is an ambient effect like every other ambient
 * effect except it has more criteria for what other weather effects it can
 * run side by side with." So there is no weather index any more: weather is
 * eight ordinary effects plus thunder, and the only thing special about them
 * is this matrix.
 *
 * No Phaser, no DOM, no imports: server/src/rooms/WorldRoom.ts imports this
 * to roll a room's active set, ambient/runtime reads it for `conflicts`, and
 * server/test pins it. Keep it that way — the server may not drag the client
 * in, and a feature may not import another feature.
 */

/** The weather effects, in the order the old WEATHER_NAMES ring had them. */
export const WEATHER_EFFECTS = [
  "cloudy", "mist", "drizzle", "rain", "heavyrain", "storm", "snow", "windy",
] as const;
export type WeatherEffect = (typeof WEATHER_EFFECTS)[number];
/** Everything the matrix ranges over: the weather effects plus thunder. */
export const WEATHER_UNIVERSE: readonly string[] = [...WEATHER_EFFECTS, "thunder"];

/** PRECIPITATION IS ONE AT A TIME. The sky does one of these, or none. */
export const PRECIPITATION: ReadonlySet<string> = new Set(["drizzle", "rain", "heavyrain", "storm", "snow"]);

/* THE MATRIX, as one-directional "may not run with" lists; `compatible` makes
 * it symmetric. Everything not named here runs with everything. The reasons
 * are physical, and each is a taste call he can overrule:
 *   thunder  — with any rain and with a dry sky, never with snow (thundersnow
 *              is a curiosity, not a mood);
 *   mist     — lies in still, damp air: cloud, drizzle, rain. Heavy rain
 *              washes it down, wind tears it, snow is another climate;
 *   windy    — blows through cloud, drizzle, rain, snow and thunder, but not
 *              mist (see above) and not storm, which carries its own gusts;
 *   cloudy   — is just cover, and goes with anything. */
const FORBID: Readonly<Record<string, readonly string[]>> = {
  thunder: ["snow"],
  mist: ["heavyrain", "storm", "snow", "windy"],
  windy: ["storm"],
};

/** May these two be active at the same time? Symmetric. */
export function compatible(a: string, b: string): boolean {
  if (a === b) return true;
  if (PRECIPITATION.has(a) && PRECIPITATION.has(b)) return false;
  if (FORBID[a]?.includes(b)) return false;
  if (FORBID[b]?.includes(a)) return false;
  return true;
}

/** Everything `name` may not run with, symmetric — what a feature declares
 *  as `conflicts` and what the Settings switches grey on. */
export function conflictsOf(name: string, universe: readonly string[]): string[] {
  return universe.filter((o) => o !== name && !compatible(name, o));
}

/** Is every pair in the set allowed? The roller's post-condition. */
export function isCompatibleSet(set: Iterable<string>): boolean {
  const a = [...set];
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) if (!compatible(a[i], a[j])) return false;
  return true;
}

/** Per-zone weights: name -> 0..1, "how often this should be active here".
 *  Absent = 0 for weather (a place that never rains never rains) and 1 for
 *  everything else (an effect the zone does not mention keeps gating on the
 *  world, as it always has). */
export type ZoneWeights = Readonly<Record<string, number>>;

/** THE WHOLE MAP AS ONE ZONE — the table the server rolls from until the maps2
 *  agent's areas land, at which point this becomes that zone's row. Weather
 *  shares are a temperate default: dry more often than not, storms rare. The
 *  independent extras (cloudy, mist, windy, thunder) are their own chance each
 *  roll, then filtered through the matrix. */
export const DEFAULT_ZONE: ZoneWeights = {
  cloudy: 0.35,
  mist: 0.1,
  drizzle: 0.12,
  rain: 0.12,
  heavyrain: 0.06,
  storm: 0.05,
  snow: 0.05,
  windy: 0.1,
  thunder: 0.4, // of the rolls it is allowed in — i.e. mostly under rain
};

/** Seconds a rolled set holds before the next roll: a weather episode. */
export const EPISODE_S: [number, number] = [240, 540];

/** ROLL ONE ACTIVE SET from the zone's weights.
 *
 *  1. Precipitation: one lottery over the five, with "none" weighing the
 *     rest of the probability mass, so the weights read as shares of time.
 *  2. Every other named effect: its own independent chance.
 *  3. Then the matrix: conflicts are resolved by DROPPING the extra, never
 *     the precipitation — a zone that rolled rain gets rain, and only loses
 *     the mist that cannot lie in it.
 *  The result is always compatible (asserted in the test), sorted, and the
 *  same input + rnd stream gives the same set (the server persists it, and
 *  a re-roll on a room recycle must not change the weather). */
export function rollAmbient(weights: ZoneWeights, rnd: () => number = Math.random): string[] {
  const out: string[] = [];
  // 1. precipitation share
  const precip = [...PRECIPITATION].filter((n) => (weights[n] ?? 0) > 0);
  const wet = precip.reduce((s, n) => s + (weights[n] ?? 0), 0);
  if (wet > 0) {
    let r = rnd() * Math.max(1, wet); // the remainder to 1 is "dry"
    for (const n of precip) {
      const w = weights[n] ?? 0;
      if (r < w) { out.push(n); break; }
      r -= w;
    }
  }
  // 2. independent extras, in a fixed order so the drop rule is deterministic
  for (const n of Object.keys(weights).sort()) {
    if (PRECIPITATION.has(n)) continue;
    const w = weights[n] ?? 0;
    if (w <= 0) continue;
    if (rnd() < w) out.push(n);
  }
  // 3. the matrix: keep precipitation, drop the extra that cannot join it
  const kept: string[] = [];
  for (const n of out) {
    if (kept.every((k) => compatible(k, n))) kept.push(n);
  }
  return kept.sort();
}

/** The wire form: sorted, comma-joined. "" is a clear sky with nothing on. */
export function packAmbient(set: Iterable<string>): string {
  return [...new Set(set)].sort().join(",");
}
export function unpackAmbient(s: string | null | undefined): Set<string> {
  return new Set((s ?? "").split(",").map((x) => x.trim()).filter(Boolean));
}

/** THE OLD RING, for the 17 gates and the local test call that still say
 *  `__ml.weather(idx)`: index -> the set that weather meant. Local only. */
export const LEGACY_INDEX: readonly (readonly string[])[] = [
  [],            // 0 Clear sky
  ["cloudy"],    // 1 Cloudy at times
  ["mist"],      // 2 Mist
  ["drizzle"],   // 3
  ["rain"],      // 4
  ["heavyrain"], // 5
  ["storm"],     // 6
  ["snow"],      // 7
  ["windy"],     // 8
];

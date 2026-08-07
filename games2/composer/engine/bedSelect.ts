/**
 * WHICH music bed the situation calls for — pure decision logic, no WebAudio.
 *
 * Split out of api.ts so it can be tested directly (test/bedSelect.test.ts):
 * a wrong answer here is a bug you can only hear by standing in the right
 * place on the right map at the right time of day, which is a terrible
 * debugging loop. Everything below is a pure function of the world sample.
 */

export type BedName = "adventure" | "town" | "cave" | "home" | "battle" | "night";

/** Priority order, most urgent first. */
export const BED_NAMES: BedName[] = ["battle", "cave", "home", "town", "night", "adventure"];

/** What the scene measures around the listener (see WorldScene.sampleAudioField). */
export interface BedInputs {
  /** 0..1 nearest-monster pressure. */
  threat?: number;
  /** 0..1 how roofed-over the player is (world@2 deck slabs overhead). */
  cave?: number;
  /** 0..1 proximity to the spawn bonfire — the "you are home" landmark. */
  fire: number;
  /** 0..1 fraction of road/farm/market tiles in earshot. */
  town: number;
  /** 0..1 sun strength (0 all night). */
  sun: number;
}

/**
 * Schmitt-trigger thresholds. Music that dithers between two beds while you
 * stand on a boundary is worse than picking the wrong one, so every trigger
 * needs a clearly higher reading to switch ON than to stay on.
 */
export const BED_ON = { battle: 0.62, cave: 0.6, home: 0.55, town: 0.5, night: 0.68 };
export const BED_OFF = { battle: 0.34, cave: 0.3, home: 0.28, town: 0.26, night: 0.48 };

/** Minimum seconds a bed holds before anything except battle may replace it. */
export const BED_MIN_HOLD_S = 6;

/**
 * When a bed has not been generated yet, degrade to the next honest choice
 * rather than going silent. An empty tail hands back to the sound-domain
 * catalog bed (i.e. exactly the behaviour that shipped before the context
 * score existed).
 */
export const BED_FALLBACK: Record<BedName, BedName[]> = {
  battle: ["adventure"],
  cave: ["night", "adventure"],
  home: ["town", "adventure"],
  town: ["adventure"],
  night: ["adventure"],
  adventure: [],
};

/** Hysteretic test: already-on stays on down to the LOW mark. */
function on(value: number, key: keyof typeof BED_ON, isCurrent: boolean): boolean {
  return value > (isCurrent ? BED_OFF[key] : BED_ON[key]);
}

/**
 * The bed the situation calls for, ignoring whether it exists yet.
 * PLACE beats TIME: a cave at night is still a cave, a town at night is still
 * a town — night only decides when nowhere in particular has a claim.
 */
export function desiredBed(f: BedInputs, current: BedName | null): BedName {
  if (on(f.threat ?? 0, "battle", current === "battle")) return "battle";
  if (on(f.cave ?? 0, "cave", current === "cave")) return "cave";
  if (on(f.fire, "home", current === "home")) return "home";
  if (on(f.town, "town", current === "town")) return "town";
  if (on(1 - f.sun, "night", current === "night")) return "night";
  return "adventure";
}

/** The best bed we can actually play for `want`, or null to use the catalog. */
export function resolveBed(want: BedName, has: (n: BedName) => boolean): BedName | null {
  for (const name of [want, ...BED_FALLBACK[want]]) if (has(name)) return name;
  return null;
}

import type Phaser from "phaser";

/** Snapshot of the world's mood, sampled from the game's `__ml` probe
 * surface (see runtime/env.ts). All fields degrade to safe defaults when a
 * probe is missing — ambient features must render sensibly from defaults. */
export interface AmbientEnv {
  /** 0..1 sun strength — 0 all night, ~1 through the sunlit phases, with
   * short sunrise/sunset ramps (the game's uSun.w). */
  sun: number;
  /** 1 - sun: the deep-dusk-to-dawn factor driving nocturnal effects. */
  night: number;
  /** 0..1 cloud cover (weather layer; 0 on a clear sky). */
  cloud: number;
  /** 0..1 mist density (weather 2). */
  mist: number;
  /** Weather index into the game's WEATHER_NAMES (0 = clear). */
  weather: number;
  /** Weather display name ("Clear sky" | "Cloudy at times" | "Mist" | …). */
  weatherName: string;
  /** Current phase name ("Night" | "Morning" | "Day" | "Evening"), best-effort. */
  phase: string;
  /** 0..1 aurora intensity (rolls in on some nights). */
  aurora: number;
  /** 0..1 — fraction of SANDY ground sampled around the player (camera
   * centre; the chase cam trails within ~2 cells). Terrain-aware effects
   * (sandstorm) gate on this. */
  sand: number;
  /** 0..1 RAIN-type precipitation intensity (Drizzle/Rain/Heavy rain/Storm —
   * NOT snow/wind), ramped with the games agent's drop count. Rain-splash
   * gates on this. Read from the game's weatherInfo().precip. */
  rain: number;
}

/** Per-frame context handed to every feature. `view` is the camera's live
 * world-view rectangle (world px), `zoom` the current camera zoom. */
export interface AmbientCtx {
  scene: Phaser.Scene;
  env: AmbientEnv;
  view: Phaser.Geom.Rectangle;
  zoom: number;
}

/** One ambient system (a folder under ambient/). Purely visual — must never
 * influence gameplay, and must be cheap while inactive.
 *
 * Two kinds (ambient/README.md):
 * - FIELD (no `weight`): always mounted, gates itself on env (fireflies by
 *   night, pollen by sun).
 * - EPISODE (`weight` + `setActive` present): run by the DIRECTOR — on every
 *   time-of-day/weather change it re-rolls a weighted lottery over the
 *   episode features; the winner is setActive(true) for that window. */
export interface AmbientFeature {
  name: string;
  /** Once, on the first update tick after the world scene is live. */
  init(ctx: AmbientCtx): void;
  /** Every frame; dt in ms. */
  update(ctx: AmbientCtx, dt: number): void;
  /** Diagnostic snapshot for __mlAmbient / verify scripts. */
  debug(): Record<string, unknown>;
  /** Tear down all display objects (scene shutdown). */
  dispose(): void;
  /** EPISODE features: relative likeliness under the given conditions —
   * base weight × condition multipliers (a bat is ~1% as likely by day).
   * Must be pure and cheap; 0 removes the feature from the draw. */
  weight?(env: AmbientEnv): number;
  /** EPISODE features: the director's on/off switch. Implementations fade
   * out gracefully on false — never hard-cut mid-flight. */
  setActive?(on: boolean): void;
  /** The conditions under which this effect is most at home — documentation
   * only now (the demo button no longer changes time-of-day; maintainer
   * 2026-07-18). `time` indexes the phase ring (0 Night … 3 Evening),
   * `weather` its WEATHER_NAMES (0 Clear, 1 Cloudy, 2 Mist). */
  preferred?: { time: number; weather: number };
  /** FIELD features: demo solo/none mode. While another effect is selected
   * (or NONE) this is set true — the field fades its gain to 0 gracefully so
   * the selected effect has the stage alone. */
  setSuppressed?(on: boolean): void;
  /** FIELD features: demo FORCE. When THIS field is the selected effect the
   * button sets it true — the field shows at full regardless of its env gate
   * (fireflies by day, pollen at night), so "select fireflies" actually
   * shows fireflies. The player's own time-of-day still grades the lighting. */
  setForced?(on: boolean): void;
  /** Effects this one CANNOT run alongside (maintainer 2026-07-19: toggle each
   * effect on/off independently, but an effect can't be enabled while an
   * incompatible one is active). Default = compatible with everything (the
   * goal is to play many at once). Declared one-directionally; the runtime
   * makes it symmetric (conflictClosure). Reasonable conflicts are day/night
   * "same-role" pairs — birds⟷bats (sky creatures), fireflies⟷pollen (motes). */
  conflicts?: string[];
}

export const PHASE_NIGHT = 0;
export const PHASE_MORNING = 1;
export const PHASE_DAY = 2;
export const PHASE_EVENING = 3;
export const WEATHER_CLEAR = 0;
export const WEATHER_CLOUDY = 1;

/** Build the SYMMETRIC conflict map from features' one-directional `conflicts`
 * lists: name → set of effect names it can't be active WITH. A UI can then
 * check either direction. Anything not listed is compatible with everything. */
export function conflictClosure(features: AmbientFeature[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!m.has(a)) m.set(a, new Set());
    m.get(a)!.add(b);
  };
  for (const f of features)
    for (const c of f.conflicts ?? []) {
      link(f.name, c);
      link(c, f.name);
    }
  return m;
}

export function defaultEnv(): AmbientEnv {
  // Default to a clear full day: with no probes nothing glows oddly, and
  // the launch features are near-invisible in plain daylight defaults.
  return {
    sun: 1,
    night: 0,
    cloud: 0,
    mist: 0,
    weather: 0,
    weatherName: "Clear sky",
    phase: "Day",
    aurora: 0,
    sand: 0,
    rain: 0,
  };
}

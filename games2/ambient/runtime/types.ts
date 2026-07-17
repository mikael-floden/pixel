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
  };
}

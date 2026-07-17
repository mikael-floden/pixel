import { AmbientEnv, AmbientFeature } from "./types";

// The DIRECTOR (maintainer 2026-07-17): time-of-day × weather drive a
// weighted lottery — every time either CHANGES, re-roll which episodic
// ambient effect plays for that window. Each episode feature computes its
// own likeliness as base × condition multipliers (bats ~1% by day; thunder
// ×2 when raining, ×3 night+raining). A QUIET slot keeps some windows
// empty on purpose — ambience that always performs stops feeling ambient.
const QUIET_WEIGHT = 0.6;

/** Demo pin: a specific episode forced on, "quiet" (all episodes off, e.g.
 * while a field feature is being demoed), or null = normal auto rolls. */
export type DirectorPin = AmbientFeature | "quiet" | null;

export class Director {
  private episodes: AmbientFeature[];
  private active: AmbientFeature | null = null;
  private lastPhase = "";
  private lastWeather = -1;
  private lastWeights: Record<string, number> = {};
  private lastEnv: AmbientEnv | null = null;
  private pin: DirectorPin = null;

  constructor(features: AmbientFeature[]) {
    this.episodes = features.filter((f) => f.weight && f.setActive);
  }

  /** Call once per env sample: detects phase/weather transitions and
   * re-rolls on change. First call (join) rolls too. Pinned (demo mode):
   * transitions are tracked but never rolled — the pin owns the stage. */
  tick(env: AmbientEnv) {
    this.lastEnv = env;
    if (env.phase === this.lastPhase && env.weather === this.lastWeather) return;
    this.lastPhase = env.phase;
    this.lastWeather = env.weather;
    if (this.pin === null) this.reroll(env);
  }

  /** Demo-mode pin (the settings ambient button). null resumes auto and
   * immediately re-rolls for the current conditions. */
  force(pin: DirectorPin) {
    this.pin = pin;
    if (pin === null) {
      if (this.lastEnv) this.reroll(this.lastEnv);
      return;
    }
    this.setActive(pin === "quiet" ? null : pin);
  }

  private setActive(pick: AmbientFeature | null) {
    if (pick === this.active) return;
    this.active?.setActive!(false); // fades out gracefully, never hard-cuts
    pick?.setActive!(true);
    this.active = pick;
  }

  /** Weighted pick over the episodes + the quiet slot. Exposed for QA. */
  reroll(env: AmbientEnv, rnd: () => number = Math.random) {
    const weights = this.episodes.map((f) => Math.max(0, f.weight!(env)));
    this.lastWeights = {};
    this.episodes.forEach((f, i) => (this.lastWeights[f.name] = weights[i]));
    const total = weights.reduce((a, b) => a + b, QUIET_WEIGHT);
    let pick: AmbientFeature | null = null;
    if (total > 0) {
      let r = rnd() * total;
      for (let i = 0; i < this.episodes.length; i++) {
        if (r < weights[i]) {
          pick = this.episodes[i];
          break;
        }
        r -= weights[i];
      }
      // falls through → the quiet slot (pick stays null)
    }
    this.setActive(pick);
  }

  debug() {
    return {
      active: this.active?.name ?? null,
      pinned: this.pin === null ? null : this.pin === "quiet" ? "quiet" : this.pin.name,
      phase: this.lastPhase,
      weather: this.lastWeather,
      weights: { ...this.lastWeights, quiet: QUIET_WEIGHT },
    };
  }
}

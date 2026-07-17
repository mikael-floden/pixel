import { AmbientEnv, AmbientFeature } from "./types";

// The DIRECTOR (maintainer 2026-07-17): time-of-day × weather drive a
// weighted lottery — every time either CHANGES, re-roll which episodic
// ambient effect plays for that window. Each episode feature computes its
// own likeliness as base × condition multipliers (bats ~1% by day; thunder
// ×2 when raining, ×3 night+raining). A QUIET slot keeps some windows
// empty on purpose — ambience that always performs stops feeling ambient.
const QUIET_WEIGHT = 0.6;

export class Director {
  private episodes: AmbientFeature[];
  private active: AmbientFeature | null = null;
  private lastPhase = "";
  private lastWeather = -1;
  private lastWeights: Record<string, number> = {};

  constructor(features: AmbientFeature[]) {
    this.episodes = features.filter((f) => f.weight && f.setActive);
  }

  /** Call once per env sample: detects phase/weather transitions and
   * re-rolls on change. First call (join) rolls too. */
  tick(env: AmbientEnv) {
    if (env.phase === this.lastPhase && env.weather === this.lastWeather) return;
    this.lastPhase = env.phase;
    this.lastWeather = env.weather;
    this.reroll(env);
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
    if (pick !== this.active) {
      this.active?.setActive!(false); // fades out gracefully, never hard-cuts
      pick?.setActive!(true);
      this.active = pick;
    }
  }

  debug() {
    return {
      active: this.active?.name ?? null,
      phase: this.lastPhase,
      weather: this.lastWeather,
      weights: { ...this.lastWeights, quiet: QUIET_WEIGHT },
    };
  }
}

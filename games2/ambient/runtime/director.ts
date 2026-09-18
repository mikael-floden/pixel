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
  private lastActive = "";
  /** Zone control ON = the server's set drives the episodes and the lottery
   *  is parked; OFF = the old free client lottery (his Settings switch). */
  zoneControl = true;
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
    const packed = [...env.active].sort().join(",");
    if (env.phase === this.lastPhase && packed === this.lastActive) return;
    this.lastPhase = env.phase;
    this.lastActive = packed;
    if (this.pin !== null) return;
    if (this.zoneControl) this.applySet(env.active);
    else this.reroll(env);
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

  /** SERVER-DRIVEN: every episode named in the set is on, every other is
   *  off. Several may run at once here (thunder under rain) — the matrix on
   *  the server already kept the set compatible. */
  private applySet(active: ReadonlySet<string>) {
    for (const f of this.episodes) {
      const want = active.has(f.name);
      const is = this.active === f || this.on.has(f);
      if (want && !is) { f.setActive!(true); this.on.add(f); }
      else if (!want && is) { f.setActive!(false); this.on.delete(f); }
    }
    this.active = null;
  }
  private on = new Set<AmbientFeature>();

  private setActive(pick: AmbientFeature | null) {
    for (const f of this.on) if (f !== pick) f.setActive!(false);
    this.on.clear();
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
      active: this.active?.name ?? ([...this.on].map((f) => f.name).join(",") || null),
      pinned: this.pin === null ? null : this.pin === "quiet" ? "quiet" : this.pin.name,
      phase: this.lastPhase,
      set: this.lastActive,
      zoneControl: this.zoneControl,
      weights: { ...this.lastWeights, quiet: QUIET_WEIGHT },
    };
  }
}

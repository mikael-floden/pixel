import { AmbientCtx, AmbientEnv, AmbientFeature } from "./types";

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
  private lastWants: Record<string, boolean> = {};
  private counts = { ticks: 0, applied: 0, ruled: 0 };
  private lastEnv: AmbientEnv | null = null;
  private pin: DirectorPin = null;

  constructor(features: AmbientFeature[]) {
    this.episodes = features.filter((f) => f.weight && f.setActive);
  }

  /** Call once per env sample: detects phase/weather transitions and
   * re-rolls on change. First call (join) rolls too. Pinned (demo mode):
   * transitions are tracked but never rolled — the pin owns the stage.
   *
   * THE BOUNDARY (maintainer 2026-09-20, with `ctx`): an episode is on when
   * its zone is anywhere in VIEW, not when the cell under my feet is in it —
   * the birds are already wheeling over the far side as I walk up, instead of
   * starting the moment I cross. That answer changes as the CAMERA moves, not
   * only when the set or the phase does, so the early-out below is skipped
   * while the field rules: five episodes x 48 field samples at the env
   * cadence, all of it off the memo. */
  tick(env: AmbientEnv, ctx?: AmbientCtx) {
    this.lastEnv = env;
    this.counts.ticks++;
    const ruled = !!ctx?.zone?.ruled;
    if (ruled) this.counts.ruled++;
    const packed = [...env.active].sort().join(",");
    const still = env.phase === this.lastPhase && packed === this.lastActive;
    if (still && !(ruled && this.zoneControl && this.pin === null)) return;
    this.lastPhase = env.phase;
    this.lastActive = packed;
    if (this.pin !== null) return;
    if (this.zoneControl) { this.counts.applied++; this.applySet(env.active, ruled ? ctx : undefined); }
    else if (!still) this.reroll(env);
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
   *  the server already kept the set compatible. With `ctx` the question is
   *  asked of the VIEW rather than of my cell (see tick). */
  private applySet(active: ReadonlySet<string>, ctx?: AmbientCtx) {
    /* ASKING THE VIEW OPENS A CONFLICT THE CELL NEVER HAD. The server resolves
     * one set per POINT, so birds and bats — which cannot run together — were
     * never both on. A view can hold a bird zone and a bat zone at once, and
     * then both want the stage. The bigger presence in view wins, the loser
     * waits; with no field this is the server's set and no pair can clash, so
     * the sort costs nothing and changes nothing. */
    const wanted: { f: AmbientFeature; w: number }[] = [];
    for (const f of this.episodes) {
      const cov = ctx ? ctx.zone.coverage(f.name, ctx.view) : null;
      const want = cov ? cov.any : active.has(f.name);
      if (want) wanted.push({ f, w: cov ? cov.max : 1 });
    }
    wanted.sort((a, b) => b.w - a.w || (a.f.name < b.f.name ? -1 : 1));
    const keep = new Set<AmbientFeature>();
    for (const { f } of wanted)
      if ([...keep].every((k) => !(k.conflicts ?? []).includes(f.name) && !(f.conflicts ?? []).includes(k.name)))
        keep.add(f);
    for (const f of this.episodes) {
      const want = keep.has(f);
      this.lastWants[f.name] = want;
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
      // WHO IS SWITCHED ON, and what the boundary thinks of each episode: the
      // ledger and the answer side by side, or a disagreement between them is
      // invisible from outside (it cost an afternoon once).
      on: [...this.on].map((f) => f.name),
      counts: { ...this.counts },
      wants: this.lastWants,
      weights: { ...this.lastWeights, quiet: QUIET_WEIGHT },
    };
  }
}

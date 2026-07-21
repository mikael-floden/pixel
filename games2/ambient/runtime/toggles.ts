import { AmbientFeature, conflictClosure } from "./types";
import { Director } from "./director";

// The ambient TOGGLE controller (maintainer 2026-07-19). The old model played
// ONE effect at a time; this lets each effect be switched on/off on its own so
// several compatible effects run together — but an effect CANNOT be switched on
// while an incompatible one is already active (see each feature's `conflicts`).
//
// Two modes:
//  - AUTO   — the DIRECTOR rolls episodes (weighted lottery) and FIELDS self-
//             gate on the environment. The game's default living behaviour.
//  - MANUAL — a SET of enabled effects drives everything directly: enabled
//             fields are forced on, enabled episodes are activated, everything
//             else is off, and the director is parked. Any manual toggle leaves
//             AUTO; setAuto(true) returns to it (and clears the manual set).
//
// This is the model the Settings UI drives (the games-ui agent builds the
// per-effect switches on top of `effects()` / `toggle()` — see ambient/README).
export type AmbientMode = "auto" | "manual";

export class Toggles {
  private enabled = new Set<string>();
  private mode: AmbientMode = "auto";
  private conflicts: Map<string, Set<string>>;

  constructor(
    private features: AmbientFeature[],
    private director: Director,
  ) {
    this.conflicts = conflictClosure(features);
  }

  private feat(name: string): AmbientFeature | undefined {
    return this.features.find((f) => f.name === name);
  }
  private isEpisode(f: AmbientFeature): boolean {
    return !!(f.weight && f.setActive);
  }

  /** Can effects `a` and `b` be active at the same time? (symmetric) */
  compatible(a: string, b: string): boolean {
    return a === b || !this.conflicts.get(a)?.has(b);
  }
  private conflictsOf(name: string): string[] {
    return [...(this.conflicts.get(name) ?? [])];
  }
  /** Which currently-enabled effect blocks enabling `name` (manual mode), or
   * null if `name` is free to switch on. */
  blockedBy(name: string): string | null {
    for (const e of this.enabled) if (e !== name && !this.compatible(name, e)) return e;
    return null;
  }

  getMode(): AmbientMode {
    return this.mode;
  }
  isEnabled(name: string): boolean {
    return this.mode === "manual" && this.enabled.has(name);
  }
  enabledNames(): string[] {
    return this.mode === "manual" ? [...this.enabled] : [];
  }

  /** Switch AUTO on (director drives, manual set cleared) or off (manual). */
  setAuto(on: boolean): void {
    this.mode = on ? "auto" : "manual";
    if (on) this.enabled.clear();
    this.apply();
  }
  /** MANUAL with nothing on. */
  none(): void {
    this.mode = "manual";
    this.enabled.clear();
    this.apply();
  }
  /** MANUAL with exactly one effect on (the old "solo" behaviour). */
  solo(name: string): void {
    this.mode = "manual";
    this.enabled.clear();
    if (this.feat(name)) this.enabled.add(name);
    this.apply();
  }

  /** Switch one effect on/off. Enabling is REFUSED if an incompatible effect
   * is already active — returns { ok:false, blockedBy } and changes nothing. */
  setEnabled(name: string, on: boolean): { ok: boolean; blockedBy: string | null } {
    if (!this.feat(name)) return { ok: false, blockedBy: null };
    this.mode = "manual";
    if (on) {
      const b = this.blockedBy(name);
      if (b) return { ok: false, blockedBy: b };
      this.enabled.add(name);
    } else {
      this.enabled.delete(name);
    }
    this.apply();
    return { ok: true, blockedBy: null };
  }
  toggle(name: string): { ok: boolean; blockedBy: string | null } {
    return this.setEnabled(name, !this.enabled.has(name));
  }

  /** Is the effect actually running right now (for status / the AUTO label). */
  private running(f: AmbientFeature): boolean {
    if (this.mode === "manual") return this.enabled.has(f.name);
    if (this.isEpisode(f)) return this.director.debug().active === f.name;
    const g = (f.debug() as { gain?: number }).gain;
    return typeof g === "number" && g > 0.25;
  }
  /** In AUTO, the name of the effect currently on (episode, else prominent
   * field, else "none") — for the settings button's "auto (…)" label. */
  autoActiveName(): string {
    const ep = this.director.debug().active as string | null;
    if (ep) return ep;
    for (const f of this.features) if (!this.isEpisode(f) && this.running(f)) return f.name;
    return "none";
  }

  /** Everything the Settings UI needs to render per-effect switches. */
  effects() {
    return this.features.map((f) => ({
      name: f.name,
      kind: this.isEpisode(f) ? ("episode" as const) : ("field" as const),
      conflicts: this.conflictsOf(f.name),
      on: this.running(f),
      enabled: this.isEnabled(f.name),
      // In MANUAL, if this effect is OFF, the enabled effect that forbids it
      // (so the UI can grey the switch and say why). null when free / already on.
      blocked: this.mode === "manual" && !this.enabled.has(f.name) ? this.blockedBy(f.name) : null,
    }));
  }

  /** Push the current mode/set onto the features + director. */
  private apply(): void {
    for (const f of this.features) {
      f.setForced?.(false);
      f.setSuppressed?.(false);
    }
    if (this.mode === "auto") {
      this.director.force(null); // director rolls; fields self-gate on env
      return;
    }
    // MANUAL: park the director, drive each feature straight from the set.
    this.director.force("quiet");
    for (const f of this.features) {
      const on = this.enabled.has(f.name);
      if (this.isEpisode(f)) f.setActive?.(on);
      else if (on) f.setForced?.(true);
      else f.setSuppressed?.(true);
    }
  }
}

import { AmbientFeature } from "./types";
import { Director } from "./director";

// The ambient DEMO cycler (maintainer 2026-07-17): a settings button
// iterates auto → each ambient effect → auto. Selecting an effect jumps the
// SHARED world time-of-day + weather to the effect's `preferred` conditions
// (via the __ml.worldTime/worldWeather probes — the {v} extension of the
// existing world-state messages) and pins the director: a demoed EPISODE is
// forced active; a demoed FIELD gets the quiet pin so no episode wanders
// into its showing. "auto" releases the pin and normal lottery life resumes.
export class Demo {
  private idx = -1; // -1 = auto

  constructor(
    private features: AmbientFeature[],
    private director: Director,
  ) {}

  label(): string {
    return this.idx < 0 ? "auto" : this.features[this.idx].name;
  }

  next(): string {
    this.set(this.idx + 1 >= this.features.length ? -1 : this.idx + 1);
    return this.label();
  }

  /** Jump straight to a feature by name (QA probe), or null for auto. */
  select(name: string | null): string {
    this.set(name === null ? -1 : this.features.findIndex((f) => f.name === name));
    return this.label();
  }

  private set(i: number) {
    this.idx = i < 0 || i >= this.features.length ? -1 : i;
    if (this.idx < 0) {
      for (const f of this.features) f.setSuppressed?.(false);
      this.director.force(null);
      return;
    }
    const f = this.features[this.idx];
    // Solo mode: the demoed effect owns the stage — every other field fades
    // out (episodes are handled by the director pin below).
    for (const other of this.features) other.setSuppressed?.(other !== f);
    if (f.preferred) {
      // Move the shared world to where this effect is most at home. Fenced
      // like every probe use — no probe, no jump, the pin still applies.
      const ml = (window as unknown as {
        __ml?: { worldTime?: (i: number) => void; worldWeather?: (i: number) => void };
      }).__ml;
      try {
        ml?.worldTime?.(f.preferred.time);
        ml?.worldWeather?.(f.preferred.weather);
      } catch {
        /* ignore */
      }
    }
    this.director.force(f.weight && f.setActive ? f : "quiet");
  }
}

import { AmbientFeature } from "./types";
import { Director } from "./director";

// The ambient DEMO cycler — the "ambient" settings button (maintainer
// 2026-07-18). It ONLY chooses which ambient effect is on; it never touches
// time-of-day or weather (the player owns those). The ring is:
//
//   AUTO → NONE → fireflies → pollen → bats → thunder → sandstorm →
//   leaves → AUTO
//
// - AUTO  — the game runs the director + fields normally; the button prints
//           "auto (<current active effect>)" so you can see what's playing.
// - NONE  — every ambient effect off.
// - <fx>  — that ONE effect, solo: episodes pin the director; fields force
//           on regardless of their env gate (so selecting fireflies shows
//           fireflies even by day — the light still grades it), and every
//           other field is suppressed.
export class Demo {
  private modes: string[]; // "auto", "none", then each feature name
  private mi = 0;

  constructor(
    private features: AmbientFeature[],
    private director: Director,
  ) {
    this.modes = ["auto", "none", ...features.map((f) => f.name)];
  }

  /** Display string (no "ambient:" prefix). AUTO reports the live effect. */
  label(): string {
    const m = this.modes[this.mi];
    return m === "auto" ? `auto (${this.activeName()})` : m;
  }

  next(): string {
    this.mi = (this.mi + 1) % this.modes.length;
    this.apply();
    return this.label();
  }

  /** Jump straight to a mode by name (QA probe): "auto"/"none"/a feature, or
   * null = auto. */
  select(name: string | null): string {
    const key = name === null ? "auto" : name;
    const i = this.modes.indexOf(key);
    this.mi = i < 0 ? 0 : i;
    this.apply();
    return this.label();
  }

  private isEpisode(f: AmbientFeature): boolean {
    return !!(f.weight && f.setActive);
  }

  /** In AUTO, what's actually on: the director's active episode, else the
   * most-prominent showing field, else "none". */
  private activeName(): string {
    const ep = this.director.debug().active as string | null;
    if (ep) return ep;
    let best: string | null = null;
    let bestGain = 0.25;
    for (const f of this.features) {
      if (this.isEpisode(f)) continue; // fields only
      const g = (f.debug() as { gain?: number }).gain;
      if (typeof g === "number" && g > bestGain) {
        bestGain = g;
        best = f.name;
      }
    }
    return best ?? "none";
  }

  private apply() {
    const m = this.modes[this.mi];
    // Clear every override first, then set what this mode wants.
    for (const f of this.features) {
      f.setForced?.(false);
      f.setSuppressed?.(false);
    }
    if (m === "auto") {
      this.director.force(null); // director rolls; fields self-gate
      return;
    }
    if (m === "none") {
      for (const f of this.features) f.setSuppressed?.(true); // all fields off
      this.director.force("quiet"); // all episodes off
      return;
    }
    // A specific effect, solo.
    const chosen = this.features.find((f) => f.name === m)!;
    for (const f of this.features) {
      if (f === chosen) f.setForced?.(true); // field: show at full (no-op on episodes)
      else f.setSuppressed?.(true); // other fields off (no-op on episodes)
    }
    this.director.force(this.isEpisode(chosen) ? chosen : "quiet");
  }
}

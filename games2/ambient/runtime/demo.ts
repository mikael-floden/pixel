import { AmbientFeature } from "./types";
import { Toggles } from "./toggles";

// The ambient "ambient" SETTINGS BUTTON cycler. It's a thin cursor over the
// Toggles controller (runtime/toggles.ts) — the real state lives there now that
// effects toggle independently (maintainer 2026-07-19). The button walks the
// ring for a quick one-at-a-time preview; the games-ui agent builds the proper
// per-effect switches on top of the Toggles API (__mlAmbient.effects/toggle).
//
//   AUTO → NONE → fireflies → pollen → water → bats → birds → thunder →
//   sandstorm → leaves → AUTO
//
// - AUTO — Toggles.setAuto(true): the director rolls + fields self-gate; the
//          button prints "auto (<current active effect>)".
// - NONE — Toggles.none(): every effect off.
// - <fx> — Toggles.solo(fx): that ONE effect, on its own.
// The LABEL always reflects the live Toggles state, so it stays honest even
// when the UI switches effects independently of this button.
export class Demo {
  private modes: string[]; // "auto", "none", then each feature name
  private mi = 0;

  constructor(
    features: AmbientFeature[],
    private toggles: Toggles,
  ) {
    this.modes = ["auto", "none", ...features.map((f) => f.name)];
  }

  /** Display string (no "ambient:" prefix) — reads the LIVE toggle state. */
  label(): string {
    if (this.toggles.getMode() === "auto") return `auto (${this.toggles.autoActiveName()})`;
    const on = this.toggles.enabledNames();
    if (on.length === 0) return "none";
    if (on.length === 1) return on[0];
    return `${on.length} effects`;
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

  private apply(): void {
    const m = this.modes[this.mi];
    if (m === "auto") this.toggles.setAuto(true);
    else if (m === "none") this.toggles.none();
    else this.toggles.solo(m);
  }
}

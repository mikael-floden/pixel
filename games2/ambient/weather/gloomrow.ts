import { AmbientFeature } from "../runtime/types";
import { WEATHER_UNIVERSE, conflictsOf } from "@nangijala/shared";
import { forceGloom } from "./gloom";

/* A GLOOM-ONLY WEATHER ROW — cloudy, mist: weather with no particles, whose
 * whole effect is the grip on the light (gloom.ts). The row exists so he can
 * see and test them like every other effect and so the matrix can forbid mist
 * under wind.
 *
 * PURE ON PURPOSE — no layer, no Phaser, no composer — so the row the game
 * registers is the row the test loads. weather.ts's factory cannot be imported
 * in node (its pooled layer imports Phaser and the composer's Vite globals),
 * which is how a row wired to nothing sat untested for two days.
 *
 * THE ROW MUST DO WHAT ITS SWITCH SAYS. Until 2026-09-19 `setForced` here
 * wrote a set only the precipitation features read, while the gloom read the
 * server's set alone — so the switch did nothing, and the maintainer's mist
 * (which no zone assigned either) could not be seen by any means he has. A
 * force now goes to the gloom (a UNION with the server's set — releasing it
 * removes only the force, never what the world rolled). Suppression (manual
 * mode, row off) is deliberately NOT passed on: the light is never optional.
 * `gain` reports the force so a probe can tell on from off. */
export function gloomOnlyRow(name: string): AmbientFeature {
  let on = false;
  let suppressed = false;
  const conflicts = conflictsOf(name, WEATHER_UNIVERSE);
  return {
    name,
    conflicts,
    init() {},
    update() {},
    setForced(want: boolean) { on = want; forceGloom(name, want); },
    setSuppressed(want: boolean) { suppressed = want; },
    debug() { return { gain: on ? 1 : 0, drawn: 0, all: [], gloomOnly: true, forced: on, suppressed, conflicts }; },
    dispose() { on = false; forceGloom(name, false); },
  };
}

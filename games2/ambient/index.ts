import type Phaser from "phaser";
import { mountAmbient as mount } from "./runtime/mount";
import { firefliesFeature } from "./fireflies/fireflies";
import { pollenFeature } from "./pollen/pollen";
import { batsFeature } from "./bats/bats";
import { thunderFeature } from "./thunder/thunder";
import { sandstormFeature } from "./sandstorm/sandstorm";
import { leavesFeature } from "./leaves/leaves";

/** The ambient-life registry — one entry per feature folder. FIELD features
 * (fireflies, pollen) gate themselves on the environment; EPISODE features
 * are rolled by the director on every time-of-day/weather change. Adding an
 * ambient system = new folder + one line here; nothing outside ambient/
 * changes (see ambient/README.md).
 *
 * REMOVED 2026-07-18: heathaze (a camera PostFX refraction) corrupted the
 * game's custom render stack — black voids, the player stopped rendering; a
 * camera-wide post-process is incompatible with this game (night-shader RTs,
 * mist pass, lit copies) and is too risky for the ambient layer, which must
 * never break the game. rainbow removed the same day (maintainer's call).
 * Both live in git history if ever revisited. */
export function mountAmbient(game: Phaser.Game) {
  mount(game, [
    firefliesFeature(),
    pollenFeature(),
    batsFeature(),
    thunderFeature(),
    sandstormFeature(),
    leavesFeature(),
  ]);
}

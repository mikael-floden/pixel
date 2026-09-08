import type Phaser from "phaser";
import { mountAmbient as mount } from "./runtime/mount";
import { firefliesFeature } from "./fireflies/fireflies";
import { pollenFeature } from "./pollen/pollen";
import { waterFeature } from "./water/water";
import { deepWaterFeature } from "./deepwater/deepwater";
import { antsFeature } from "./ants/ants";
import { spidersFeature } from "./spiders/spiders";
import { mothsFeature } from "./moths/moths";
import { gnatsFeature } from "./gnats/gnats";
import { crabsFeature } from "./crabs/crabs";
import { bubblesFeature } from "./bubbles/bubbles";
import { batsFeature } from "./bats/bats";
import { birdsFeature } from "./birds/birds";
import { thunderFeature } from "./thunder/thunder";
import { sandstormFeature } from "./sandstorm/sandstorm";
import { leavesFeature } from "./leaves/leaves";

/** The ambient-life registry — one entry per feature folder. FIELD features
 * (fireflies, pollen, water) gate themselves on the environment/terrain;
 * EPISODE features are rolled by the director on every time-of-day/weather
 * change. Adding an
 * ambient system = new folder + one line here; nothing outside ambient/
 * changes (see ambient/README.md).
 *
 * REMOVED 2026-07-18: heathaze (a camera PostFX refraction) corrupted the
 * game's custom render stack — black voids, the player stopped rendering; a
 * camera-wide post-process is incompatible with this game (night-shader RTs,
 * mist pass, lit copies) and is too risky for the ambient layer, which must
 * never break the game. rainbow removed the same day (maintainer's call).
 * Both live in git history if ever revisited. */
/* NOT REGISTERED: embers/ is written but PARKED. It needs to know whether a
 * light is a FIRE, and nothing published says so — the scenery light block is
 * {strength, color, radius, states} with no type, `tags` is ["SCENERY"] on every
 * piece, the game's own `flicker` is a brightness decision that calls a street
 * lamp a flame, and colour cannot classify (the_game ships a blue resin torch).
 * Classifying by piece GROUP was written and works, but it is a guess in this
 * repo's clothing, and the maintainer is having the scenery domain publish the
 * real field instead (2026-09-08). Add the line back when it lands. */
export function mountAmbient(game: Phaser.Game) {
  mount(game, [
    firefliesFeature(),
    pollenFeature(),
    waterFeature(),
    deepWaterFeature(),
    antsFeature(),
    spidersFeature(),
    mothsFeature(),
    gnatsFeature(),
    crabsFeature(),
    bubblesFeature(),
    batsFeature(),
    birdsFeature(),
    thunderFeature(),
    sandstormFeature(),
    leavesFeature(),
  ]);
}

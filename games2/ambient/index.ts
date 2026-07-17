import type Phaser from "phaser";
import { mountAmbient as mount } from "./runtime/mount";
import { firefliesFeature } from "./fireflies/fireflies";
import { pollenFeature } from "./pollen/pollen";
import { batsFeature } from "./bats/bats";
import { thunderFeature } from "./thunder/thunder";
import { rainbowFeature } from "./rainbow/rainbow";
import { sandstormFeature } from "./sandstorm/sandstorm";
import { tumbleweedFeature } from "./tumbleweed/tumbleweed";

/** The ambient-life registry — one entry per feature folder. FIELD features
 * (fireflies, pollen) gate themselves on the environment; EPISODE features
 * (bats, thunder, rainbow) are rolled by the director on every
 * time-of-day/weather change. Adding an ambient system = new folder + one
 * line here; nothing outside ambient/ changes (see ambient/README.md). */
export function mountAmbient(game: Phaser.Game) {
  mount(game, [
    firefliesFeature(),
    pollenFeature(),
    batsFeature(),
    thunderFeature(),
    rainbowFeature(),
    sandstormFeature(),
    tumbleweedFeature(),
  ]);
}

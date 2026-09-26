// The bodies the stage casts with and at — shared by the viewer and the
// single-file bundle (pipeline/bundle.mjs), so the two cannot disagree.
// Every monster here SHIPS in the game image (a world spawns it): a monster
// no world spawns 404s at /assets/monsters/... in production.

export const HEROES = { default_boy: "Boy", default_girl: "Girl" };
// The first is the default target (maintainer 2026-09-26: "Instead of
// Werewolf as default please use Palehusk instead!").
export const MONSTERS = {
  malformed_creature: "Palehusk",
  diablo: "Ashfiend",
  granite_bear: "Cragback",
  diablo_2: "Balefiend",
  blight_elk: "Sporehorn",
  ice_wolf: "Winterfang",
  forest_poring: "Dewling",
};
/** A chain's other victims: person-sized. */
export const EXTRA_MONSTER = "diablo";

/** THE EXTRA TRANSITIONS SWITCH — the two boundary rules the game adds on top
 *  of render3's picture (both in `Tiles3Data`): a NATURE WALL'S FOOT composes
 *  a ground<->face transition tile (maintainer 2026-09-09: "When a nature wall
 *  (not a house, etc) intersect the ground we should make the ground a
 *  transition/boundary tile"), and a DECK SLAB composes transitions at its own
 *  level ("The ground up here also look very sharp and has no
 *  transition/boundary tiles", on the cave lid). ONE switch for both, in
 *  Settings, on by default; off is byte-for-byte the resolver's parity
 *  picture. Same contract as fadetune.ts: this module owns the value, the
 *  Settings button is the only writer, the scene re-resolves and repaints on
 *  "ml-extra-transitions". */

const KEY = "ml-extra-transitions";
let value: boolean = load();

function load(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

export function extraTransitions(): boolean {
  return value;
}

export function setExtraTransitions(on: boolean): void {
  if (on === value) return;
  value = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-extra-transitions", { detail: on }));
}

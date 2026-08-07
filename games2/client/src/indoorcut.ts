/** INDOOR WALL CUT — the Settings dial (maintainer 2026-08-07).
 *
 * "My idea was to instead cut all walls at 'roof - 1', 'roof - 2', etc. Even
 * making this configurable in settings so I can test what looks best."
 *
 * So the value is a whole number of LEVELS taken off the top of the building
 * while you are inside it. The renderer draws every column of the enclosure —
 * floor, near wall, far wall, corner — truncated at
 *
 *     indoorTop = max(0, ceiling - cut)
 *
 * and draws nothing above that. One dial therefore does both jobs at once:
 *
 *   cut 1  → the roof and the topmost band go; the walls stand nearly full
 *            height and a near one still hides most of the room.
 *   cut 3  → half of a 6-level house; you look over the near wall at a body
 *            standing behind it.
 *   cut 6+ → the walls are gone entirely and the floor plan lies open.
 *
 * WHY A COUNT OF LEVELS AND NOT A HEIGHT. The cut is measured DOWN FROM EACH
 * ROOM'S OWN CEILING, never from level 0 — the_island2's house is 6 levels tall
 * and its cave ceiling sits at 8 over rock walls 24-40 levels high. An absolute
 * height would leave the cave a sealed box at any value that flattered the
 * house. Relative, one dial suits both.
 *
 * Owned here rather than in WorldScene or hud.ts because both need it: the HUD
 * writes it, the renderer reads it when it rebuilds the mask, and it has to
 * survive a reload. Same shape as indoorlight.ts and controls.ts: one
 * localStorage key, one window event, no imports either way.
 */

const KEY = "ml-indoor-cut";

/** Levels the dial can take off. The floor is 1 because 0 means "cut nothing",
 * and with the roof back on there would be no indoor mode left to look at —
 * the roof is not a special case here, it is simply the part above the cut.
 * The ceiling is 8 because that is the tallest ceiling any shipped world has
 * (the_island2's cave, deckBot 8); past it every room is already flattened to
 * its floor and the dial stops doing anything. */
export const INDOOR_CUT_MIN = 1;
export const INDOOR_CUT_MAX = 8;

/** Default = 3.
 *
 * Chosen against the ART, not by taste: a character is ~64px tall and a level
 * is 16px (MAP_GEOMETRY.lh), so a body stands about 4 levels high. At the
 * shipped house's ceiling of 6, a cut of 3 leaves a 3-level parapet — under
 * the shoulder line of anyone standing behind it, so the head and torso read
 * over every near wall while the room still looks like a room rather than a
 * floor plan. Cut 2 hides the head; cut 4 starts to lose the walls. */
export const INDOOR_CUT_DEFAULT = 3;

let value = load();

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return INDOOR_CUT_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clamp(v) : INDOOR_CUT_DEFAULT;
  } catch {
    return INDOOR_CUT_DEFAULT; // private mode / storage disabled
  }
}

const clamp = (v: number) =>
  Math.max(INDOOR_CUT_MIN, Math.min(INDOOR_CUT_MAX, Math.round(v)));

/** The dial, in LEVELS below each room's own ceiling. */
export function indoorCut(): number {
  return value;
}

/** Set the dial and tell the renderer. Fires "ml-indoor-cut" so the scene
 * rebuilds its mask and repaints — no polling, and the slider stays the single
 * writer. */
export function setIndoorCut(v: number): void {
  const next = clamp(v);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-indoor-cut", { detail: next }));
}

/** Label for the slider's readout — the maintainer's own vocabulary. */
export function indoorCutLabel(): string {
  return `roof −${value}`;
}

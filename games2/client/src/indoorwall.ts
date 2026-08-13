/** INDOOR WALL HEIGHT — the Settings dial.
 *
 * How tall the walls stand while you are inside, in LEVELS ABOVE THE ROOM'S
 * OWN FLOOR. The renderer draws every column of the world truncated at
 *
 *     indoorTop = roomFloor + <this dial>
 *
 * and draws nothing above it. One dial does both jobs at once: the roof is
 * above the cut so it goes, and the near walls become a parapet you look over.
 *
 * MEASURED UP FROM THE FLOOR, NOT DOWN FROM THE ROOF (maintainer 2026-08-07).
 * The first cut of this dial was "roof − N", and it was wrong for exactly the
 * reason he found by walking into a cave: the number you are choosing is a WALL
 * HEIGHT, and roof−N only equals a wall height when every room has the same
 * ceiling. They do not. the_island2's house has its ceiling at 6, so roof−4
 * left the 2 levels of wall he liked; its caves have theirs at 8 over a level-0
 * floor, so the same roof−4 left FOUR — twice as tall, in the one place you
 * most want to see in ("I can see that the walls are higher than what I wanted.
 * This is because we take 'roof - x' and not 'floor + x'"). Measured from the
 * floor the dial means the same thing everywhere: 2 is 2, in a cottage and in a
 * cathedral.
 *
 * The ceiling still matters as a CLAMP — a wall taller than the room it is in
 * would just seal the box again — so the renderer takes
 * `min(roomFloor + dial, ceiling)`.
 *
 * Owned here rather than in WorldScene or hud.ts because both need it: the HUD
 * writes it, the renderer reads it when it rebuilds the mask, and it has to
 * survive a reload. Same shape as indoorlight.ts and controls.ts: one
 * localStorage key, one window event, no imports either way.
 */

/** A NEW key on purpose. The old one (`ml-indoor-cut`) stored a roof−N depth,
 * and the same number means something different now — reading 4 back would
 * hand anyone who had tuned the old dial four levels of wall instead of the
 * two they had chosen. Better to start everyone on the new default. */
const KEY = "ml-indoor-wall";

/** How tall the walls may be asked to stand.
 *
 * The floor is 1 because 0 is no wall at all — the floor plan lying open, with
 * nothing left to read as a room.
 *
 * The ceiling is 6 because that is the tallest shipped ROOM (the_island2's
 * house, floor 0 to ceiling 6): past it every room in the game is clamped and
 * the slider has nothing left to say. Note this is the opposite end from the
 * old roof−N dial, whose max was about the SHALLOWEST room — measured from the
 * floor, what bounds the dial is the deepest one. */
export const INDOOR_WALL_MIN = 1;
export const INDOOR_WALL_MAX = 6;

/** Default = 1 level — lowered from 2 the day the dial became a MINIMUM
 * (maintainer 2026-08-13: "with this new change it looks better if the default
 * is 1 level and not 2"). Since the per-wall raise, only the walls that would
 * hide the room stay at this height — everything else rises to the ceiling —
 * so the near parapet can afford to be knee-high: the tall raised walls carry
 * the "this is a room" reading now. (2 was his pick while ALL walls stood at
 * the dial; that context is gone.) A level is 16px, a body ~64px. */
export const INDOOR_WALL_DEFAULT = 1;

let value = load();

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return INDOOR_WALL_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clamp(v) : INDOOR_WALL_DEFAULT;
  } catch {
    return INDOOR_WALL_DEFAULT; // private mode / storage disabled
  }
}

const clamp = (v: number) =>
  Math.max(INDOOR_WALL_MIN, Math.min(INDOOR_WALL_MAX, Math.round(v)));

/** The dial, in LEVELS above the room's own floor. */
export function indoorWall(): number {
  return value;
}

/** Set the dial and tell the renderer. Fires "ml-indoor-wall" so the scene
 * rebuilds its mask and repaints — no polling, and the slider stays the single
 * writer. */
export function setIndoorWall(v: number): void {
  const next = clamp(v);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-indoor-wall", { detail: next }));
}

/** Label for the slider's readout. */
export function indoorWallLabel(): string {
  return `${value} level${value === 1 ? "" : "s"}`;
}

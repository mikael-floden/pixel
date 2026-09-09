/** SCENERY ANIMATION SLEEP — how long a piece rests between plays of its
 *  idle clip, per animation CLASS, as a min-max range in seconds.
 *
 *  The maintainer (2026-09-09): "I want scenery objects that has a GOOD or
 *  APPROVED animation state to play the animation in game. The animation
 *  should play once then do a random sleep until they play again. The interval
 *  they sleep in is controlled with range sliders per scenery type (tree,
 *  fire, etc). I will use the sliders to find a good default and will tell
 *  you what the defaults should be." A clip on repeat "might look good for
 *  something like a fire, but it will definitely not look good for a tree".
 *
 *  THE CLASSES ARE THE SCENERY AGENT'S (`review_metrics.class` on every
 *  animation: foliage, fire, water, rigid) — the same taxonomy its review
 *  judged the clips by, and the one where "tree" and "fire" are different
 *  answers. A clip with no class is `rigid`. Range [0, 0] means back to back.
 *
 *  Same contract as fadetune.ts: this module owns the values and their
 *  persistence, the Settings range sliders are the only writers, and the scene
 *  reads the range each time it schedules a sleep — so a drag shows on the
 *  next play, no re-resolve. The defaults below are a first guess; the
 *  maintainer names the real ones. */

export const SCENERY_ANIM_CLASSES = ["foliage", "fire", "water", "rigid"] as const;
export type SceneryAnimClass = (typeof SCENERY_ANIM_CLASSES)[number];
export type SleepRange = [number, number];
export type SceneryAnimTune = Record<SceneryAnimClass, SleepRange>;

export const SCENERY_ANIM_LABEL: Record<SceneryAnimClass, string> = {
  foliage: "Trees & foliage",
  fire: "Fire",
  water: "Water",
  rigid: "Rigid pieces",
};
/** The longest sleep a slider can set, in seconds. */
export const SCENERY_SLEEP_MAX = 60;
/** Frames per second every clip plays at (the library carries no rate). */
export const SCENERY_ANIM_FPS = 8;

export const SCENERY_ANIM_DEFAULT: SceneryAnimTune = {
  foliage: [6, 18],
  fire: [0, 1],
  water: [1, 4],
  rigid: [10, 30],
};

const KEY = "ml-scenery-anim";
let value: SceneryAnimTune = load();

function clampRange(r: unknown, d: SleepRange): SleepRange {
  if (!Array.isArray(r) || r.length !== 2) return [...d] as SleepRange;
  const n = (x: unknown, f: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.min(SCENERY_SLEEP_MAX, x)) : f;
  const lo = n(r[0], d[0]);
  const hi = n(r[1], d[1]);
  return lo <= hi ? [lo, hi] : [hi, lo];
}

function load(): SceneryAnimTune {
  const out = { ...SCENERY_ANIM_DEFAULT };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const v = JSON.parse(raw) as Partial<Record<SceneryAnimClass, unknown>>;
    for (const c of SCENERY_ANIM_CLASSES) out[c] = clampRange(v[c], SCENERY_ANIM_DEFAULT[c]);
  } catch {
    /* unreadable — the defaults */
  }
  return out;
}

export function sceneryAnimTune(): SceneryAnimTune {
  return value;
}

/** The class a clip's sleep is drawn from — a class the library does not name
 *  (or none) is `rigid`. */
export function sceneryAnimClass(cls: string | null | undefined): SceneryAnimClass {
  return (SCENERY_ANIM_CLASSES as readonly string[]).includes(cls ?? "") ? (cls as SceneryAnimClass) : "rigid";
}

/** One sleep, in milliseconds, drawn uniformly from the class's range. */
export function scenerySleepMs(cls: SceneryAnimClass, rand: () => number = Math.random): number {
  const [lo, hi] = value[cls];
  return (lo + (hi - lo) * rand()) * 1000;
}

export function setSceneryAnimTune(cls: SceneryAnimClass, range: SleepRange): void {
  const next = clampRange(range, value[cls]);
  if (next[0] === value[cls][0] && next[1] === value[cls][1]) return;
  value = { ...value, [cls]: next };
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-scenery-anim", { detail: value }));
}

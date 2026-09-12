/** HOW OFTEN A GROUND DETAIL IS SHOWN — a Settings slider (maintainer
 * 2026-09-12: "A detail tile is a tile that looks amazing, but not if tiled.
 * It should just be displayed now and then at locations where it looks
 * good … Can you add a slider for how often a detail should be shown? Can you
 * make the range here kinda big? Both in min and max value?").
 *
 * The value is ONE DETAIL IN EVERY N FIELD CELLS: the resolver rolls a fixed
 * per-cell hash against 1/N (`Tiles3.plateFor`), so a detail never shifts and
 * the slider only changes how many cells win the roll. The travel is
 * GEOMETRIC from every cell (N = 1, the tiled look he says a detail must never
 * have — the top of the range, so he can see it) to one in ten thousand (in
 * effect off), 56 steps, so half the track lives between 1 in 10 and 1 in
 * 1,000 where the look is decided. The default is the rate the game always
 * used (`DETAIL_FREQ` = 1/56).
 *
 * Owned here like lightscale.ts: the HUD-side dial (detaildial.ts) writes it,
 * "ml-detail-rate" rebuilds the resolver (WorldScene's reResolve, the fade
 * dials' path) on both threads. Node-safe: no DOM at module scope. */
export const DETAIL_EVERY_DEFAULT = 56;
export const DETAIL_EVERY_MIN = 1;
export const DETAIL_EVERY_MAX = 10000;
export const DETAIL_EVERY_STEPS = 56;
const KEY = "ml-detail-every";
const RATIO = DETAIL_EVERY_MAX / DETAIL_EVERY_MIN;
/** One step's ratio (~1.18). The grid is ANCHORED ON THE DEFAULT, so 1 in 56
 *  is a stop on it and the reset button lands exactly where the game always
 *  rolled; the ends clamp. */
const STEP = Math.pow(RATIO, 1 / DETAIL_EVERY_STEPS);

const g = globalThis as unknown as {
  window?: { dispatchEvent(e: unknown): void };
  CustomEvent?: new (t: string, i?: { detail?: unknown }) => unknown;
};

const clamp = (n: number): number => (n < DETAIL_EVERY_MIN ? DETAIL_EVERY_MIN : n > DETAIL_EVERY_MAX ? DETAIL_EVERY_MAX : n);

/** Snap to the geometric grid, then to a WHOLE number of cells — "1 in 56"
 *  is the unit he reads, and 1/56.3 would print the same and mean another. */
export function snapDetailEvery(n: number): number {
  const k = Math.round(Math.log(clamp(n) / DETAIL_EVERY_DEFAULT) / Math.log(STEP));
  return clamp(Math.round(DETAIL_EVERY_DEFAULT * Math.pow(STEP, k)));
}

/** Slider position 0..1 -> N, and back. The top of the track is the most
 *  details (N = 1), the bottom the fewest. */
export const detailEveryFromSlider = (p: number): number => snapDetailEvery(DETAIL_EVERY_MAX / Math.pow(RATIO, p < 0 ? 0 : p > 1 ? 1 : p));
export const sliderFromDetailEvery = (n: number): number => 1 - Math.log(clamp(n) / DETAIL_EVERY_MIN) / Math.log(RATIO);

let value = load();
function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (Number.isFinite(v) && v > 0) return snapDetailEvery(v);
  } catch {
    /* storage blocked: the default */
  }
  return DETAIL_EVERY_DEFAULT;
}

/** N: one detail in every N field cells. */
export function detailEvery(): number {
  return value;
}

/** The rate the resolver rolls against. */
export function detailRate(): number {
  return 1 / value;
}

export function setDetailEvery(n: number): void {
  const next = snapDetailEvery(n);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  if (g.window && g.CustomEvent) g.window.dispatchEvent(new g.CustomEvent("ml-detail-rate", { detail: next }));
}

/** `1 in 56`; `every cell` at the top. */
export function detailEveryLabel(n: number = value): string {
  return n <= 1 ? "every cell" : `1 in ${n.toLocaleString("en-US")}`;
}

/** HOW HIGH THE COMPOSED SLOPE CLIMBS, as a share of the storey — his Settings
 *  switch (maintainer 2026-09-24: "make one that is 25% higher, 50% higher, 75%
 *  higher and 100% higher. The 100% one show no wall at all this is a clean
 *  slope without stairs. 0% is what we have today. But you need to use the
 *  'base tile set' when creating this artificial slopes"). 0 keeps his
 *  published 4 px sets (the half step); 25..100 compose a ramp from the cell's
 *  own member plate (tiles3draw `buildRampPixels`) that climbs that share of
 *  the 15 px storey, the wall above it what is left.
 *
 *  THE DEFAULT IS AUTO (-2): slopes are always on, and every slope run picks
 *  its own height from his mix (rampfield.ts `SLOPE_MIX`: off 2, 25% 1,
 *  50% 3, 100% 2) — maintainer 2026-09-26: "The idea with the game is not to
 *  have this as a button. We need a auto alternative that implements it the
 *  way we intend. And that is to always have it on and use the following
 *  weights". The fixed stops stay on the switch for side-by-side checks; OFF
 *  (-1) lists no slope set (tiles3 `slopeSets`), so every rise is the plain
 *  stair. The storage key is new with the auto stop, so a value stored before
 *  it (the old default was off) cannot keep slopes off. Owned here like
 *  detailrate.ts: "ml-slope-height" rebuilds the resolver on both threads.
 *  Node-safe: no DOM at module scope. */
import { slopeRunShares, type RampFieldWorld } from "./rampfield";

export const SLOPE_OFF = -1;
export const SLOPE_AUTO = -2;
/* THE STOPS HE KEPT (maintainer 2026-09-25, on the lab page: "the 4px slope
 * looks like shit. The 75% also looks like shit. It leaves a single stripe that
 * looks buggy. 25%, 50% and 100% looks good"). 0 and 75 are no longer offered;
 * a stored one snaps to the nearest kept stop. The resolver still reads 0 as the
 * published half step (its tests pin it), the switch just never sends it. */
export const SLOPE_HEIGHTS = [SLOPE_AUTO, SLOPE_OFF, 25, 50, 100] as const;
export const SLOPE_HEIGHT_DEFAULT = SLOPE_AUTO;
const KEY = "ml-slope-height3";

const g = globalThis as unknown as {
  window?: { dispatchEvent(e: unknown): void };
  CustomEvent?: new (t: string, i?: { detail?: unknown }) => unknown;
};

function snap(n: number): number {
  if (n === SLOPE_AUTO) return SLOPE_AUTO;
  let best: number = SLOPE_OFF;
  for (const h of SLOPE_HEIGHTS) if (Math.abs(h - n) < Math.abs(best - n)) best = h;
  return best;
}

let value = load();
function load(): number {
  try {
    const v = localStorage.getItem(KEY);
    if (v !== null) {
      const n = Number(v);
      if (Number.isFinite(n)) return snap(n);
    }
  } catch {
    /* storage blocked: the default */
  }
  return SLOPE_HEIGHT_DEFAULT;
}

/** The share, 0..100, SLOPE_OFF or SLOPE_AUTO. */
export function slopeHeight(): number {
  return value;
}

export function setSlopeHeight(n: number): void {
  const next = snap(n);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage blocked: the session keeps it */
  }
  if (g.window && g.CustomEvent) g.window.dispatchEvent(new g.CustomEvent("ml-slope-height", { detail: next }));
}

/** The switch as he reads it: "auto", "off", "4 px" (the half step) or the share. */
export function slopeLabel(n = value): string {
  return n === SLOPE_AUTO ? "auto" : n < 0 ? "off" : n === 0 ? "4 px" : `${n}%`;
}

/** THE SLOPE RULE A RESOLVER RUNS for a stop, over its own copy of the world:
 *  `slopeHeight` for Tiles3Data (the fixed share, -0.01 for off; 1 for auto,
 *  which only says "ramps on" — the cell's own share wins) and, for auto, the
 *  per-cell shares in % (rampfield `slopeRunShares`). The main thread, the
 *  worker and the light each build it from the same world.json, so they agree
 *  cell for cell without a structured clone. */
export function slopeRule(world: RampFieldWorld, n = value): { slopeHeight: number; shares: Uint8Array | null } {
  if (n !== SLOPE_AUTO) return { slopeHeight: n / 100, shares: null };
  // One pass per world object (11-23 ms on the_game, dev host): the resolver
  // and the light ask for the same world at every rebuild.
  let shares = runMemo.get(world);
  if (!shares) runMemo.set(world, (shares = slopeRunShares(world)));
  return { slopeHeight: 1, shares };
}
const runMemo = new WeakMap<object, Uint8Array>();

/** The next stop on the switch, wrapping: auto -> off -> 25 -> 50 -> 100 -> auto. */
export function nextSlopeHeight(): number {
  const i = SLOPE_HEIGHTS.indexOf(value as (typeof SLOPE_HEIGHTS)[number]);
  return SLOPE_HEIGHTS[(i + 1) % SLOPE_HEIGHTS.length];
}

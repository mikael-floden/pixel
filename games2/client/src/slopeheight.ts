/** HOW HIGH THE COMPOSED SLOPE CLIMBS, as a share of the storey — his Settings
 *  switch (maintainer 2026-09-24: "make one that is 25% higher, 50% higher, 75%
 *  higher and 100% higher. The 100% one show no wall at all this is a clean
 *  slope without stairs. 0% is what we have today. But you need to use the
 *  'base tile set' when creating this artificial slopes"). 0 keeps his
 *  published 4 px sets (the half step); 25..100 compose a ramp from the cell's
 *  own member plate (tiles3draw `buildRampPixels`) that climbs that share of
 *  the 15 px storey, the wall above it what is left. Owned here like
 *  detailrate.ts: "ml-slope-height" rebuilds the resolver on both threads.
 *  Node-safe: no DOM at module scope. */
export const SLOPE_HEIGHTS = [0, 25, 50, 75, 100] as const;
export const SLOPE_HEIGHT_DEFAULT = 100;
const KEY = "ml-slope-height";

const g = globalThis as unknown as {
  window?: { dispatchEvent(e: unknown): void };
  CustomEvent?: new (t: string, i?: { detail?: unknown }) => unknown;
};

function snap(n: number): number {
  let best: number = SLOPE_HEIGHT_DEFAULT;
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

/** The share, 0..100. */
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

/** The next stop on the switch, wrapping: 100 -> 0 -> 25 -> ... */
export function nextSlopeHeight(): number {
  const i = SLOPE_HEIGHTS.indexOf(value as (typeof SLOPE_HEIGHTS)[number]);
  return SLOPE_HEIGHTS[(i + 1) % SLOPE_HEIGHTS.length];
}

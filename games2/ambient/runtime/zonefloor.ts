import type { AmbientZone } from "@nangijala/shared";
import { zoneHolds } from "@nangijala/shared";

/* A ZONE'S FLOOR — the ground level the mist pools ON, instead of sea level.
 *
 * MIST_FRAG hugs the ground with `pool = 1 - (z - 0.4) * 0.5`, which measures
 * height above LEVEL 0. That was invisible while every mist zone sat at sea
 * level, and it silently deleted the effect the moment maps2 placed mist where
 * mist belongs. Measured over the world's five 90%-mist zones (2026-09-23,
 * mean pool per zone):
 *
 *   tarn-the-tarn                       floor 32, median 32   0.000
 *   lake-the-southern-lake              floor  4, median 12   0.000
 *   meadow-the-south-western-meadow-2   floor  2, median  4   0.010
 *   marsh-the-eastern-marsh             floor  0, median  2   0.196   <- his report
 *   heath-the-south-eastern-green       floor  0, median  0   0.763
 *
 * Four of five painted nothing. A tarn is a MOUNTAIN lake; there is no height
 * above sea level at which "this is a misty place" stops being true. So the
 * falloff measures height above the zone's own floor, and "hugs the ground"
 * finally means the ground it is standing on.
 *
 * THE FLOOR IS THE MEDIAN, NOT THE MINIMUM. A minimum is one cell and one
 * stray low cell inside a zone would drag the whole zone's fog back down —
 * his marsh has level-0 water in it and a level-2 bank, and the minimum would
 * have changed nothing there. The median says "half this place is at or below
 * here": the lower half pools full (pool clamps at 1) and the rises inside the
 * zone thin out, which is the look he approved, now relative to its own place.
 *
 * COMPUTED ONCE PER ZONE and cached by id — a zone's polygon and the terrain
 * under it never move, so this is a constant. It is deliberately NOT derived
 * from the view: a reference that changes as the camera pans would make the
 * density breathe as he walks, which is the class of artifact ("flicker in and
 * out of existence") this whole line of work exists to remove.
 *
 * Pure: a level lookup is injected, so the server test runs it with no Phaser
 * and no world loaded.
 */

/** Levels per byte in the mask texture's G channel. The world tops out at 46
 *  levels, so 4 covers it (0..63) with quarter-level resolution to spare —
 *  a floor is a whole number anyway. MIST_FRAG decodes with the same constant;
 *  change both together. */
export const REF_SCALE = 4;

/** At most this many cells are sampled for one zone's median. The whole-world
 *  zone is 155k cells; a stride keeps the once-per-zone cost flat, and a
 *  median is exactly the statistic a uniform subsample estimates well. */
export const FLOOR_SAMPLE_CAP = 4000;

/** The median terrain level over the cells a zone holds. `levelAt` takes a
 *  cell's centre in WORLD UNITS (the game's `__ml.levelAt`) and answers null
 *  while the probe is not up; cells are walked over the polygon's bounding box
 *  with a stride chosen so no more than `cap` are read.
 *
 *  NULL means "could not be measured", which the caller must NOT cache — a
 *  floor is a constant and a wrong one is permanent. 0 means sea level, which
 *  is a real answer (the heath). */
export function zoneFloorLevel(
  zone: AmbientZone,
  levelAt: (wx: number, wy: number) => number | null,
  cellWu: number,
  cap = FLOOR_SAMPLE_CAP,
): number | null {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of zone.area) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(x1 > x0) || !(y1 > y0)) return 0;
  const box = (x1 - x0) * (y1 - y0);
  // one stride for both axes: a stride that samples ~cap cells of the box
  const stride = Math.max(1, Math.ceil(Math.sqrt(box / Math.max(1, cap))));
  const levels: number[] = [];
  // the zone's own elev band, when it declares one, is the level it means
  const lo = zone.elev ? zone.elev[0] : 0;
  for (let row = Math.floor(y0); row < y1; row += stride)
    for (let col = Math.floor(x0); col < x1; col += stride) {
      if (!zoneHolds(zone, col, row, lo)) continue;
      const v = levelAt(col * cellWu + cellWu / 2, row * cellWu + cellWu / 2);
      if (v === null) return null; // the probe is not up: unmeasured, not zero
      levels.push(v);
    }
  if (levels.length === 0) return 0;
  levels.sort((a, b) => a - b);
  return levels[levels.length >> 1];
}

/** Among zones ALREADY KNOWN to hold a cell, the one that owns `name`: the
 *  largest share, tie broken by the smaller zone then the id. The same rule
 *  `resolveAmbientAt` decides the effect itself with, so the floor a point
 *  reads belongs to the zone that put the effect there. No geometry — the
 *  field calls this on the zones its per-cell memo already resolved, which is
 *  why the floor costs no polygon tests. */
export function pickOwner(held: readonly AmbientZone[], name: string): AmbientZone | null {
  let best: AmbientZone | null = null;
  let bestShare = 0;
  for (const z of held) {
    const share = z.effects[name] ?? 0;
    if (!(share > 0)) continue;
    if (
      !best ||
      share > bestShare ||
      (share === bestShare &&
        ((z.cells ?? Infinity) < (best.cells ?? Infinity) ||
          ((z.cells ?? Infinity) === (best.cells ?? Infinity) && z.id < best.id)))
    ) {
      best = z;
      bestShare = share;
    }
  }
  return best;
}

/** The same, for a cell whose holders are not known yet: filter by geometry
 *  first. Null when no zone here carries the effect. */
export function floorOwnerAt(
  zones: readonly AmbientZone[],
  name: string,
  col: number,
  row: number,
  elev: number,
): AmbientZone | null {
  return pickOwner(zones.filter((z) => zoneHolds(z, col, row, elev)), name);
}

/** Pack a floor level into the mask's G byte (and clamp it into range). */
export function packRef(level: number): number {
  const v = Math.round(level * REF_SCALE);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

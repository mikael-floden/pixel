import { AmbientCtx } from "./types";

/* WHERE A FIELD EFFECT MAY LIVE — the zone boundary for everything that is
 * not weather (crabs, ants, spiders, gnats, fireflies, …).
 *
 * Maintainer 2026-09-20: "The crabs, ants, spiders, etc already exist in that
 * zone before I walk in. I can stand outside a zone and see effects like a
 * crab on the other side, but not on this side."
 *
 * Field effects used to self-gate on TERRAIN alone (a beach, a lake, damp
 * ground) and never read the zone set at all, so a crab appeared on every
 * beach in the world. Two rules fix that, and they are the whole of this
 * module:
 *
 *  1. A feature is WANTED when its zone is anywhere in VIEW (`any`), never
 *     when the cell under my feet says so — which is what makes the crabs
 *     already be there as I walk up to the line, instead of popping in
 *     around me.
 *  2. A spot is ACCEPTED with the probability of the field's weight there
 *     (`accept`). Inside the zone that is 1 and nothing changes; across the
 *     three-cell feather the POPULATION thins instead of the sprites fading,
 *     which is the honest way to soften a boundary for a discrete animal —
 *     a half-transparent crab is a ghost, half as many crabs is a beach
 *     petering out.
 *
 * Coverage costs 48 field samples, so it is read at the env cadence and on a
 * table change, never per frame (the weather rows learned this first).
 */

/** How often a watch re-reads its zone's coverage of the view (ms). */
export const COVER_EVERY_MS = 100;
/** Below this the field is off: nothing is held here at all. */
export const ZONE_MIN = 0.02;
/** A DISCRETE ANIMAL is placed only at or above this — the field's own line.
 *  The blur puts 0.667 on the first cell inside a straight edge and 0.333 on
 *  the first cell outside, so a half is "the zone's own side" almost exactly.
 *  Measured: with the old 0.02 floor a crab was accepted two cells OUTSIDE
 *  the polygon and walked up to the player standing there, which is the one
 *  thing the maintainer asked for by name — "I can stand outside a zone and
 *  see a crab on the other side, but not on this side". The thinning he also
 *  wants still happens, on the INSIDE ramp: a spot at the edge is taken half
 *  the time, one well inside every time. */
export const PLACE_MIN = 0.5;
/** A drifting thing re-reads the field after this much travel (px). */
export const DRIFT_REREAD_PX = 24;

export interface ZoneCover {
  any: boolean;
  mean: number;
  max: number;
}

const OPEN: ZoneCover = { any: true, mean: 1, max: 1 };

/** One effect's view of the zone field, cached at the env cadence. */
export class ZoneWatch {
  private cov: ZoneCover = OPEN;
  private age = Infinity;
  private ver = -1;

  constructor(readonly name: string) {}

  /** Call once per update with the frame's dt. Cheap: it re-samples at most
   *  ten times a second, and not at all where zones do not rule. */
  step(ctx: AmbientCtx, dtMs: number): void {
    const zone = ctx.zone;
    if (!zone || !zone.ruled) { this.cov = OPEN; this.age = Infinity; this.ver = -1; return; }
    this.age += dtMs;
    if (this.age < COVER_EVERY_MS && this.ver === zone.tableVersion) return;
    this.age = 0;
    this.ver = zone.tableVersion;
    const c = zone.coverage(this.name, ctx.view);
    this.cov = { any: c.any, mean: c.mean, max: c.max };
  }

  /** Is this effect's zone anywhere on screen? (True where zones do not rule.) */
  get any(): boolean { return this.cov.any; }
  /** The share of the view it holds — what a population scales by. */
  get mean(): number { return this.cov.mean; }
  /** Its strongest presence in view. */
  get max(): number { return this.cov.max; }

  /** The field's weight at a drawn point, 1 where zones do not rule. */
  at(ctx: AmbientCtx, x: number, y: number): number {
    return ctx.zone ? ctx.zone.weightAt(this.name, x, y) : 1;
  }

  /** MAY SOMETHING LIVE HERE? On the zone's own side of the line, accepted
   *  with the probability of the weight — so the population tapers toward the
   *  edge from the inside and nothing stands on the far side of it. Pass the
   *  feature's own `rnd` so a seeded gate stays reproducible. */
  accept(ctx: AmbientCtx, x: number, y: number, rnd: () => number): boolean {
    const w = this.at(ctx, x, y);
    return w >= PLACE_MIN && rnd() < w;
  }

  /** Is this spot still in the zone? (No dice — for re-validating something
   *  already placed, where a coin flip would make it flicker.) */
  holds(ctx: AmbientCtx, x: number, y: number): boolean {
    return this.at(ctx, x, y) > ZONE_MIN;
  }

  /** A DRIFTING THING (a firefly, a pollen mote) is not placed once and left:
   *  it wanders, so it re-reads the field as it goes and DRAWS at the weight
   *  it last read. For a glow or a mote a partial alpha is honest — it reads
   *  as distance or haze, not as a ghost, which is why the discrete animals
   *  thin their population instead. The read is by DISTANCE travelled, never
   *  per frame: eight reads across the three-cell ramp at any frame rate
   *  (a frame count overshot the ramp by four cells at headless rates, which
   *  the weather sheet paid for first). */
  drift(ctx: AmbientCtx, d: { zw: number; zx: number; zy: number }, x: number, y: number): number {
    if (Math.abs(x - d.zx) >= DRIFT_REREAD_PX || Math.abs(y - d.zy) >= DRIFT_REREAD_PX) {
      d.zw = this.at(ctx, x, y);
      d.zx = x;
      d.zy = y;
    }
    return d.zw;
  }

  /** Start a drifting thing at (x, y): reads the field there and now. */
  seed(ctx: AmbientCtx, d: { zw: number; zx: number; zy: number }, x: number, y: number): number {
    d.zw = this.at(ctx, x, y);
    d.zx = x;
    d.zy = y;
    return d.zw;
  }

  /** For `debug()`: what the boundary is doing to this effect right now. */
  info(): { any: boolean; mean: number; max: number } {
    return { any: this.cov.any, mean: +this.cov.mean.toFixed(3), max: +this.cov.max.toFixed(3) };
  }
}

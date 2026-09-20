import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { PRECIP, Cfg, weatherDescriptors } from "./precip";
import { WEATHER_UNIVERSE, conflictsOf } from "@nangijala/shared";
import { PrecipLayer } from "./layer";
import type { ZoneCoverage } from "../runtime/zonefield";
import { forceGloom } from "./gloom";
import { gloomOnlyRow } from "./gloomrow";

/* WEATHER IS AMBIENT (maintainer 2026-09-17: "That should have always been an
 * ambient effect ... I give you full rights to change the game so you have
 * full control over the whether effects!"). It lived in
 * client/src/weatherfx.ts, driven straight from WorldScene; it is six
 * registered ambient features now, one per precipitation, so each gets its own
 * Settings row like every other effect.
 *
 * TWO LOCKS KEEP THE RAIN TYPES APART AT ONE POINT, which is the thing he asked
 * for:
 *
 *  1. STRUCTURAL, in AUTO. The server never rolls two precipitations for one
 *     zone (the matrix), and the zone field resolves one owner per effect per
 *     cell, so at any POINT one precipitation falls. Two can share a VIEW
 *     across a boundary, and that is the point of the per-row sheets below.
 *  2. DECLARED, in MANUAL. `conflicts` lists the other five, and
 *     `conflictClosure` makes that symmetric, so the Settings UI greys a
 *     switch the moment an incompatible one is on. This is the half that
 *     actually needed saying: in manual mode a player CAN force effects on by
 *     hand, and without this snow and heavy rain would happily overlap.
 */

/** How often a row re-reads its zone coverage of the view (ms) — the env
 *  tick's cadence. */
export const COVER_EVERY_MS = 100;

export function weatherFeatures(): AmbientFeature[] {
  /* ONE SHEET PER ROW (2026-09-20). It was one pooled layer for six rows,
   * on the premise that the world has one weather at a time; weather is per
   * ZONE now and a view can hold two (snow on the eastern summit beside the
   * western summit's storm — 17 such neighbouring pairs on maps2's tables),
   * so each row draws its own sheet where its own weight is on. A sheet with
   * nothing in view steps an empty pool. */
  const forced = new Set<string>();
  const suppressed = new Set<string>();
  const gains = new Map<string, number>();
  const covers = new Map<string, number>();

  // the descriptors are the single source of truth for name + conflicts
  // (pure, in precip.ts, so the unit test reads the same rule the features do)
  const desc = new Map(weatherDescriptors().map((d) => [d.name, d]));
  const others = (name: string) => desc.get(name)?.conflicts ?? [];

  const make = (cfg: Cfg): AmbientFeature => {
    const layer = new PrecipLayer();
    /* the view's coverage is 48 field samples; read at the env cadence
     * (COVER_EVERY_MS) and on a table change, not per frame — the sheet's
     * density eases over seconds, so a tenth of a second of staleness on
     * "is its zone in view" is invisible, and 6 rows x 48 picks x 60 Hz is not */
    let cov: ZoneCoverage | null = null;
    let covMs = Infinity;
    let covVer = -1;
    return {
      name: cfg.name,
      conflicts: others(cfg.name),
      init() { /* the layer builds its textures on the first step */ },
      update(ctx: AmbientCtx, dt: number) {
        /* WANTED WHEN ITS ZONE IS ANYWHERE IN VIEW — not when my cell says so
         * (maintainer 2026-09-20: "I should walk into an area/zone that is
         * already snowing"): the field's coverage of the view decides, and the
         * sheet places every drop by that field. Where zones do not rule (no
         * doc, a forced sky) the room's set is the answer, as before. A player
         * forcing the row on in Settings gets the whole view.
         * `outdoor` is the charter's gate: weather does not fall through a
         * roof the game has cut away. */
        const isForced = forced.has(cfg.name);
        const ruled = ctx.zone.ruled && !isForced;
        if (ruled) {
          covMs += dt;
          if (!cov || covMs >= COVER_EVERY_MS || covVer !== ctx.zone.tableVersion) {
            cov = ctx.zone.coverage(cfg.name, ctx.view);
            covMs = 0;
            covVer = ctx.zone.tableVersion;
          }
        } else cov = null;
        const wants = !suppressed.has(cfg.name) && (isForced || (cov ? cov.any : ctx.env.active.has(cfg.name)));
        const g = wants ? ctx.outdoor : 0;
        gains.set(cfg.name, g);
        covers.set(cfg.name, cov ? cov.mean : 1);
        layer.setWeather(g > 0.004 ? cfg : null, g);
        layer.step(ctx, dt, ruled ? (x, y) => ctx.zone.weightAt(cfg.name, x, y) : null);
      },
      // A FORCED ROW SHOWS ITS WHOLE EFFECT — the sheet here, and its grip on
      // the light in gloom.ts, or a storm forced on to look at it falls out of
      // a clear blue sky. Release goes to the gloom too; suppression does not
      // (the light is never optional — see gloom.ts).
      setForced(on: boolean) {
        if (on) forced.add(cfg.name); else forced.delete(cfg.name);
        forceGloom(cfg.name, on);
      },
      setSuppressed(on: boolean) { if (on) suppressed.add(cfg.name); else suppressed.delete(cfg.name); },
      debug() {
        const info = layer.info();
        return {
          idx: cfg.idx,
          gain: +(gains.get(cfg.name) ?? 0).toFixed(3),
          cover: +(covers.get(cfg.name) ?? 1).toFixed(3),
          holding: info.kind === cfg.name,
          // `all[].a` must be the DRAWN alpha on EVERY path (charter): the
          // sheet draws each drop at its own zone weight, so the typical drop
          // is cfg.alpha x gain x the mean weight drawn (info.w has min too).
          all: info.drawn ? [{ a: +(cfg.alpha * info.gain * (info.w.mean || 0)).toFixed(3), n: info.drawn }] : [],
          drawn: info.drawn,
          splashes: info.splashes,
          rest: info.rest,
          flashes: info.flashes,
          layer: info,
          conflicts: others(cfg.name),
        };
      },
      dispose() { forceGloom(cfg.name, false); layer.dispose(); },
    };
  };

  // CLOUDY and MIST: weather with no particles — the row is pure, in
  // gloomrow.ts, so the row the game registers is the row the test loads.
  return [gloomOnlyRow("cloudy"), gloomOnlyRow("mist"), ...PRECIP.map((cfg) => make(cfg))];
}

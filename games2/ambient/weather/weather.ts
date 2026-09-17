import { AmbientCtx, AmbientFeature } from "../runtime/types";
import { PRECIP, Cfg, weatherDescriptors } from "./precip";
import { PrecipLayer } from "./layer";

/* WEATHER IS AMBIENT (maintainer 2026-09-17: "That should have always been an
 * ambient effect ... I give you full rights to change the game so you have
 * full control over the whether effects!"). It lived in
 * client/src/weatherfx.ts, driven straight from WorldScene; it is six
 * registered ambient features now, one per precipitation, so each gets its own
 * Settings row like every other effect.
 *
 * TWO LOCKS KEEP THE RAIN TYPES APART, which is the thing he asked for:
 *
 *  1. STRUCTURAL, in AUTO. Each feature gates on `env.weather === its index`
 *     and the world has exactly ONE weather index, so two can never want the
 *     stage at once however the director rolls.
 *  2. DECLARED, in MANUAL. `conflicts` lists the other five, and
 *     `conflictClosure` makes that symmetric, so the Settings UI greys a
 *     switch the moment an incompatible one is on. This is the half that
 *     actually needed saying: in manual mode a player CAN force effects on by
 *     hand, and without this snow and heavy rain would happily overlap.
 *
 * ONE POOL, NOT SIX. Only one weather can draw, so the six share a single
 * `PrecipLayer` held in this factory's closure — six pools would be six times
 * the sprites for one visible sheet. Every feature's `update` runs every frame
 * (runtime/mount.ts), in array order, so each writes its request and THE LAST
 * ONE CREATED resolves: it picks the strongest request and steps the layer
 * exactly once. Ordering is deterministic, so there is no frame of latency and
 * no double-step — the thing to preserve if these are ever re-registered.
 */

interface Req { gain: number; cfg: Cfg }

export function weatherFeatures(): AmbientFeature[] {
  const layer = new PrecipLayer();
  const reqs = new Map<string, Req>();
  const forced = new Set<string>();
  const suppressed = new Set<string>();
  /* NO SECOND EASE ON THE GAIN. The density ease inside the layer is the ONE
   * fade a weather has — that is how weatherfx.ts worked, and adding a 4 s
   * gain roll on top of the 4 s density roll left a storm still raining ~8 s
   * after the sky went clear (measured live: 160 drops on weather 0, and
   * RISING). When nothing wants the sheet the layer is handed `null` and
   * hides every drop at once, exactly as before. */
  const gains = new Map<string, number>();

  // the descriptors are the single source of truth for name + conflicts
  // (pure, in precip.ts, so the unit test reads the same rule the features do)
  const desc = new Map(weatherDescriptors().map((d) => [d.name, d]));
  const others = (name: string) => desc.get(name)?.conflicts ?? [];

  const make = (cfg: Cfg, isResolver: boolean): AmbientFeature => ({
    name: cfg.name,
    conflicts: others(cfg.name),
    init() { /* the layer builds its textures on the first step */ },
    update(ctx: AmbientCtx, dt: number) {
      // WANTED when the world says so, or when a player forced this row on.
      // `outdoor` is the charter's gate — weather does not fall through a roof
      // the game has cut away.
      const wants = !suppressed.has(cfg.name) && (forced.has(cfg.name) || ctx.env.weather === cfg.idx);
      // `outdoor` is the charter's gate and the one behaviour this port ADDS:
      // weatherfx.ts drew the sheet through a roof the game had cut away.
      const g = wants ? ctx.outdoor : 0;
      gains.set(cfg.name, g);
      if (g > 0.004) reqs.set(cfg.name, { gain: g, cfg });
      else reqs.delete(cfg.name);

      if (!isResolver) return;
      // ---- resolve: every feature has written its request by now ----
      let best: Req | null = null;
      for (const r of reqs.values()) if (!best || r.gain > best.gain) best = r;
      layer.setWeather(best?.cfg ?? null, best?.gain ?? 0);
      layer.step(ctx, dt);
    },
    setForced(on: boolean) { if (on) forced.add(cfg.name); else forced.delete(cfg.name); },
    setSuppressed(on: boolean) { if (on) suppressed.add(cfg.name); else suppressed.delete(cfg.name); },
    debug() {
      const info = layer.info();
      const mine = info.kind === cfg.name;
      return {
        idx: cfg.idx,
        gain: +(gains.get(cfg.name) ?? 0).toFixed(3),
        holding: mine,
        // `all[].a` must be the DRAWN alpha on EVERY path (charter): when this
        // weather is not the one on the stage it draws nothing, and says so.
        all: mine ? [{ a: +(cfg.alpha * info.gain).toFixed(3), n: info.drawn }] : [],
        drawn: mine ? info.drawn : 0,
        splashes: mine ? info.splashes : 0,
        rest: mine ? info.rest : 0,
        flashes: mine ? info.flashes : 0,
        layer: info,
        conflicts: others(cfg.name),
      };
    },
    dispose() { if (isResolver) layer.dispose(); },
  });

  return PRECIP.map((cfg, i) => make(cfg, i === PRECIP.length - 1));
}

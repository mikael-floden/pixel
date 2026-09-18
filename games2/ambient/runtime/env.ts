import { AmbientEnv, defaultEnv } from "./types";
import { precipShown } from "./precipstate";

/** Sample the world's mood off the game's documented `__ml` probe surface.
 * Every read is fenced: a missing/reshaped probe yields the daylight default
 * for that field (ambient fades out rather than erroring — the charter's
 * degrade-gracefully rule). Callers throttle this (~10 Hz) — the probes
 * allocate small objects and per-frame sampling would be pure waste. */
export function sampleEnv(prev?: AmbientEnv, cx?: number, cy?: number): AmbientEnv {
  const env = prev ?? defaultEnv();
  const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
  if (!ml) return env;
  try {
    // Terrain awareness: fraction of sandy ground in a 3×3 sample around
    // the player (camera centre; the chase cam trails within ~2 cells).
    // CAREFUL: surfaceAt takes FLAT grid world-units, but the camera centre
    // is in iso-projected screen px — pickAt converts screen -> flat ground
    // point (it's what tap-to-move uses). Sampling surfaceAt with screen
    // coords silently reads off-grid and always answers "no sand".
    const at = ml.surfaceAt as undefined | ((x: number, y: number) => { sound?: string } | null);
    const pick = ml.pickAt as undefined | ((x: number, y: number) => { x: number; y: number } | null);
    if (at && pick && typeof cx === "number" && typeof cy === "number") {
      const p = pick(cx, cy);
      if (p) {
        let hits = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (at(p.x + dx * 40, p.y + dy * 40)?.sound === "sand") hits++;
          }
        env.sand = hits / 9;
      }
    }
  } catch {
    /* no terrain yet — keep previous */
  }
  try {
    const s = (ml.sunInfo as undefined | (() => { sun: number[]; phase: string }))?.();
    if (s && Array.isArray(s.sun) && typeof s.sun[3] === "number") {
      env.sun = clamp01(s.sun[3]);
      env.night = 1 - env.sun;
      if (typeof s.phase === "string") env.phase = s.phase;
    }
  } catch {
    /* probe drifted — keep previous/default */
  }
  try {
    const act = (ml.ambientActive as undefined | (() => string[]))?.();
    env.active = new Set(Array.isArray(act) ? act.filter((n) => typeof n === "string") : []);
  } catch {
    env.active = new Set();
  }
  try {
    const w = (
      ml.weatherInfo as undefined
      | (() => { idx: number; name: string; cloud: number; mist?: number; precip?: { shown?: number } | null })
    )?.();
    if (w) {
      if (typeof w.cloud === "number") env.cloud = clamp01(w.cloud);
      if (typeof w.mist === "number") env.mist = clamp01(w.mist);
      // Rain-splash intensity: rain KINDS only (not snow/wind), ramped with
      // the games agent's live drop count so splashes appear as the rain
      // rolls in, not before.
      // the strongest rain KIND in the active set (names are stable ids)
      let kind = 0;
      for (const n of env.active) kind = Math.max(kind, RAIN_INTENSITY[n] ?? 0);
      // The DRAWN density comes from ambient's own weather layer now, not
      // from the game (ambient owns weather since 2026-09-17) — see
      // runtime/precipstate.ts for why the seam lives in runtime/.
      const ramp = Math.min(1, precipShown() / 40);
      env.rain = kind * ramp;
    }
  } catch {
    /* ignore */
  }
  try {
    const a = (ml.aurora as undefined | (() => number))?.();
    if (typeof a === "number") env.aurora = clamp01(a);
  } catch {
    /* ignore */
  }
  return env;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// Rain-splash intensity per RAIN weather name (games agent's WEATHER_NAMES).
// Snow / Windy are precipitation but not rain → no splashes.
const RAIN_INTENSITY: Record<string, number> = {
  drizzle: 0.35,
  rain: 0.7,
  heavyrain: 1,
  storm: 1,
};

/** Is the current weather a rainy/stormy one? Matches by NAME so thunder's
 * ×2 and the rainbow's rain weight pick up the games agent's rain weathers
 * (Drizzle/Rain/Heavy rain/Storm) automatically. */
export function isRainy(env: AmbientEnv): boolean {
  for (const n of env.active) if (n === "thunder" || (RAIN_INTENSITY[n] ?? 0) > 0) return true;
  return false;
}

/** ROUGH AIR — storm, snow or wind is on. What `env.weather >= 6` used to
 *  mean: nothing small hovers, flutters or hangs in it. */
export function isRough(env: { active: ReadonlySet<string> }): boolean {
  return env.active.has("storm") || env.active.has("snow") || env.active.has("windy");
}

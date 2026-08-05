import { AmbientEnv, defaultEnv } from "./types";

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
    const w = (
      ml.weatherInfo as undefined
      | (() => { idx: number; name: string; cloud: number; mist?: number; precip?: { shown?: number } | null })
    )?.();
    if (w) {
      if (typeof w.cloud === "number") env.cloud = clamp01(w.cloud);
      if (typeof w.mist === "number") env.mist = clamp01(w.mist);
      if (typeof w.idx === "number") env.weather = w.idx;
      if (typeof w.name === "string") env.weatherName = w.name;
      // Rain-splash intensity: rain KINDS only (not snow/wind), ramped with
      // the games agent's live drop count so splashes appear as the rain
      // rolls in, not before.
      const kind = RAIN_INTENSITY[w.name] ?? 0;
      const shown = w.precip && typeof w.precip.shown === "number" ? w.precip.shown : null;
      const ramp = shown === null ? 1 : Math.min(1, shown / 40);
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
  Drizzle: 0.35,
  Rain: 0.65,
  "Heavy rain": 1.0,
  Storm: 1.0,
};

/** Is the current weather a rainy/stormy one? Matches by NAME so thunder's
 * ×2 and the rainbow's rain weight pick up the games agent's rain weathers
 * (Drizzle/Rain/Heavy rain/Storm) automatically. */
export function isRainy(env: AmbientEnv): boolean {
  return /drizzle|rain|storm|thunder|shower/i.test(env.weatherName);
}

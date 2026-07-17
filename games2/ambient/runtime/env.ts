import { AmbientEnv, defaultEnv } from "./types";

/** Sample the world's mood off the game's documented `__ml` probe surface.
 * Every read is fenced: a missing/reshaped probe yields the daylight default
 * for that field (ambient fades out rather than erroring — the charter's
 * degrade-gracefully rule). Callers throttle this (~10 Hz) — the probes
 * allocate small objects and per-frame sampling would be pure waste. */
export function sampleEnv(prev?: AmbientEnv): AmbientEnv {
  const env = prev ?? defaultEnv();
  const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
  if (!ml) return env;
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
      ml.weatherInfo as undefined | (() => { idx: number; name: string; cloud: number; mist?: number })
    )?.();
    if (w) {
      if (typeof w.cloud === "number") env.cloud = clamp01(w.cloud);
      if (typeof w.mist === "number") env.mist = clamp01(w.mist);
      if (typeof w.idx === "number") env.weather = w.idx;
      if (typeof w.name === "string") env.weatherName = w.name;
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

/** Is the current weather a rainy/stormy one? No rain weather exists yet
 * (Clear/Cloudy/Mist as of 2026-07-17) — matching by NAME means the day the
 * games agent ships "Rain"/"Storm", thunder's ×2 kicks in with no edit here. */
export function isRainy(env: AmbientEnv): boolean {
  return /rain|storm|thunder|shower/i.test(env.weatherName);
}

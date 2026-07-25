// Bird DENSITY — the player-controlled "how many birds" ratio (maintainer
// 2026-07-25: a Settings slider "0.1 (10% of what we have today) all the way up
// to 10x"). ONE knob, read by BOTH bird flocks (the settling ground flock AND
// the high-altitude migratory flock in birds/birds.ts) so a single slider scales
// the whole sky. Exposed on window.__mlAmbient.birdDensity(v?) (see mount.ts) so
// the games-ui Settings slider can read/write it.
//
// Persisted in localStorage so the choice survives reloads/rejoins. Kept in this
// tiny runtime module (not inside birds.ts) so mount.ts can expose the getter/
// setter without importing the whole feature, and so a future critter type could
// share the same ratio.

const KEY = "ml-bird-density";
export const DENSITY_MIN = 0.1; // 10% of today
export const DENSITY_MAX = 10; // 10× today
const DEFAULT = 1; // today's amount

const clamp = (v: number): number =>
  !Number.isFinite(v) ? DEFAULT : Math.max(DENSITY_MIN, Math.min(DENSITY_MAX, v));

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return DEFAULT;
    const v = parseFloat(raw);
    return Number.isFinite(v) ? clamp(v) : DEFAULT;
  } catch {
    return DEFAULT; // no storage (private mode / SSR) → the default
  }
}

let ratio = load();

/** The current density ratio in [DENSITY_MIN, DENSITY_MAX] (1 = today's amount). */
export function birdDensity(): number {
  return ratio;
}

/** Set the ratio (clamped) and persist it. Returns the stored value. */
export function setBirdDensity(v: number): number {
  ratio = clamp(v);
  try {
    localStorage.setItem(KEY, String(ratio));
  } catch {
    /* storage unavailable — keep the in-memory value for this session */
  }
  return ratio;
}

/** THE THREE FADE DIALS — how a ground eases into its neighbour with the
 *  library's fade tiles. The maintainer's design (2026-09-09, on the beach
 *  fades reading as "random dots"): "I kinda feel I need 3 sliders in order to
 *  nail this" —
 *
 *  REACH   how far from the other ground the warm-up starts, in cells (0..4).
 *  AMOUNT  how many fade tiles are placed, LINEAR: twice the value is twice
 *          the tiles (0..3x of the shipped density).
 *  FALLOFF the exponent on distance: how much denser the band is right at the
 *          edge than at its far end (1 = the shipped straight line; higher =
 *          hugs the edge; lower = even).
 *
 *  ...and a fourth switch he asked for in the same breath: whether a fade may
 *  sit ON a transition tile itself (a 50/50 sand-grass tile carrying a grassy
 *  fade reads as 75/25).
 *
 *  Same contract as indoorlight.ts: this module owns the values and their
 *  persistence, the Settings sliders are the only writers, and the scene
 *  re-resolves the world on "ml-fade-tune". The defaults are EXACTLY the
 *  shipped behaviour (band 2, probability 0.45 x linear distance, fades never
 *  on a boundary), so the resolver's parity gates hold at rest. */

export interface FadeTune {
  reach: number;
  amount: number;
  falloff: number;
  onBoundary: boolean;
}

export const FADE_TUNE_DEFAULT: FadeTune = { reach: 2, amount: 1, falloff: 1, onBoundary: false };
export const FADE_REACH_MAX = 4;
export const FADE_AMOUNT_MAX = 3;
/** falloff = FALLOFF_MIN * (FALLOFF_MAX/FALLOFF_MIN)^p — a log dial, 0.25..4, 1 at the middle. */
export const FADE_FALLOFF_MIN = 0.25;
export const FADE_FALLOFF_MAX = 4;

const KEY = "ml-fade-tune";
let value: FadeTune = load();

function load(): FadeTune {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...FADE_TUNE_DEFAULT };
    const v = JSON.parse(raw) as Partial<FadeTune>;
    const num = (x: unknown, d: number, lo: number, hi: number) =>
      typeof x === "number" && Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d;
    return {
      reach: Math.round(num(v.reach, FADE_TUNE_DEFAULT.reach, 0, FADE_REACH_MAX)),
      amount: num(v.amount, FADE_TUNE_DEFAULT.amount, 0, FADE_AMOUNT_MAX),
      falloff: num(v.falloff, FADE_TUNE_DEFAULT.falloff, FADE_FALLOFF_MIN, FADE_FALLOFF_MAX),
      onBoundary: typeof v.onBoundary === "boolean" ? v.onBoundary : FADE_TUNE_DEFAULT.onBoundary,
    };
  } catch {
    return { ...FADE_TUNE_DEFAULT };
  }
}

export function fadeTune(): FadeTune {
  return value;
}

export function setFadeTune(patch: Partial<FadeTune>): void {
  const next = { ...value, ...patch };
  if (
    next.reach === value.reach &&
    next.amount === value.amount &&
    next.falloff === value.falloff &&
    next.onBoundary === value.onBoundary
  )
    return;
  value = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-fade-tune", { detail: next }));
}

/* -- slider <-> value maps (the sliders are 0..1) -------------------------- */
export const reachFromSlider = (p: number): number => Math.round(p * FADE_REACH_MAX);
export const sliderFromReach = (r: number): number => r / FADE_REACH_MAX;
export const amountFromSlider = (p: number): number => +(p * FADE_AMOUNT_MAX).toFixed(2);
export const sliderFromAmount = (a: number): number => a / FADE_AMOUNT_MAX;
export const falloffFromSlider = (p: number): number =>
  +(FADE_FALLOFF_MIN * Math.pow(FADE_FALLOFF_MAX / FADE_FALLOFF_MIN, p)).toFixed(3);
export const sliderFromFalloff = (f: number): number =>
  Math.log(f / FADE_FALLOFF_MIN) / Math.log(FADE_FALLOFF_MAX / FADE_FALLOFF_MIN);

/** THE THREE FADE DIALS — how a ground eases into its neighbour with the
 *  library's fade tiles. The maintainer's design (2026-09-09, on the beach
 *  fades reading as "random dots"): "I kinda feel I need 3 sliders in order to
 *  nail this" —
 *
 *  REACH   how far from the other ground the warm-up starts, in cells (0..8).
 *  AMOUNT  how many fade tiles are placed, LINEAR: twice the value is twice
 *          the tiles (0..4x of the shipped density).
 *  FALLOFF how fast the COVERAGE drops with distance: the tiles with the most
 *          of the other ground on them sit at the transition, the ones with
 *          least at the far end of the band, and this exponent bends the
 *          curve between (1 = straight; higher = only the edge gets the dense
 *          tiles; lower = dense tiles reach further). Maintainer 2026-09-09:
 *          "tiles that has very much light_soil on top of grass should be
 *          used at the tile that does the actual transition and tiles that
 *          has very little ... further away. The 'Fade falloff' slider
 *          controls this behavior." (It used to bend the DENSITY instead.)
 *
 *  `onBoundary` — whether a fade may sit ON a transition tile itself — is
 *  ALWAYS FALSE (a 50/50 sand-grass tile carrying a grassy fade reads as
 *  75/25; maintainer 2026-09-12: "should always be off", and its switch is
 *  gone). The field stays because the resolver reads it; a stored value is
 *  ignored.
 *
 *  Same contract as indoorlight.ts: this module owns the values and their
 *  persistence, the Settings sliders are the only writers, and the scene
 *  re-resolves the world on "ml-fade-tune". The defaults are the maintainer's
 *  picks (below); the resolver's own constants stay the parity fixtures'. */

export interface FadeTune {
  reach: number;
  amount: number;
  falloff: number;
  onBoundary: boolean;
}

/** THE MAINTAINER'S DEFAULTS (2026-09-09, tuned on the phone with the three
 *  sliders: "This is good fade defaults"): reach 4, amount 0.46x, falloff 4.
 *  The resolver's own constants (FADE_BAND 2, 1x, exponent 1) are what the
 *  render3 parity fixtures pin and are unchanged; the game hands it THESE. */
export const FADE_TUNE_DEFAULT: FadeTune = { reach: 4, amount: 0.46, falloff: 4, onBoundary: false };
/* THE DIALS RUN WELL PAST THE DEFAULTS. He found his numbers with reach and
 * falloff both pinned at the old top of their tracks (4 cells, exp 4): "it was
 * hard to test because you limited the sliders enormously." A dial whose
 * chosen value is its maximum has not been explored past it. */
export const FADE_REACH_MAX = 8;
export const FADE_AMOUNT_MAX = 4;
/** falloff = FALLOFF_MIN * (FALLOFF_MAX/FALLOFF_MIN)^p — a log dial, 0.1..32. */
export const FADE_FALLOFF_MIN = 0.1;
export const FADE_FALLOFF_MAX = 32;

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
      onBoundary: false,
    };
  } catch {
    return { ...FADE_TUNE_DEFAULT };
  }
}

export function fadeTune(): FadeTune {
  return value;
}

export function setFadeTune(patch: Partial<FadeTune>): void {
  const next = { ...value, ...patch, onBoundary: false };
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

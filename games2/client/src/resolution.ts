/** THE RENDER RESOLUTION — a Settings slider (maintainer 2026-09-12: "Can you
 * add a resolution slider … 1/2 {width}×{height}, 1/4, 1/8 … maybe resolution
 * is also an issue"; then "add a 2/3 and 1/3 resolution (I know it's not good
 * to not have even numbers here, but it still gives the user more options)").
 *
 * The canvas is backed at `devicePixelRatio` (capped at 4) times its CSS size;
 * this dial multiplies that backing by 1, 2/3, 1/2, 1/3, 1/4 or 1/8 and the
 * camera zoom shrinks by the same fraction, so the SAME world fills the screen
 * with the square of the fraction in fragments — 2/3 is 44%, 1/2 a quarter,
 * 1/8 a sixty-fourth. Measured on his phone (frames over 50 ms per 30 s
 * window): 1/1 7 and 21, 1/2 4 and 2, 1/4 12 and 23 — below 1/2 nothing more
 * comes back, so the fill is only part of the frame and the rest is the CPU
 * bursts perf.md tracks. His verdict: 1/1 "looks best by far", the game has
 * to earn it; the dial stays as a player's option. The light fields are a
 * fraction of the canvas, so their ceiling follows this dial by construction
 * ("cannot be bigger than the resolution") and their readout names the same
 * units (`resFractionLabel`).
 *
 * A step whose zoom is not a whole number of backing pixels per world pixel
 * (2/3 and 1/3 always; 1/4 and 1/8 on a phone whose full zoom is 2) resamples
 * the art, and camzoom.ts's tile seam can show — the price of the option.
 *
 * Owned here, like lightscale.ts: the HUD-side dial (resdial.ts) writes it,
 * main.ts resizes the canvas on "ml-render-res", the scene re-derives its zoom.
 * Node-safe (no DOM at module scope) for the same reason lightscale.ts is. */
export const RENDER_RES_STEPS = [1, 2 / 3, 0.5, 1 / 3, 0.25, 0.125] as const;
export const RENDER_RES_DEFAULT = 1;
const KEY = "ml-render-res";

const g = globalThis as unknown as {
  window?: { dispatchEvent(e: unknown): void };
  CustomEvent?: new (t: string, i?: { detail?: unknown }) => unknown;
};

/** The nearest legal step. */
export function snapRenderRes(v: number): number {
  let best: number = RENDER_RES_STEPS[0];
  for (const s of RENDER_RES_STEPS) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

let value = load();
function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (Number.isFinite(v) && v > 0) return snapRenderRes(v);
  } catch {
    /* storage blocked: full */
  }
  return RENDER_RES_DEFAULT;
}

/** The fraction of the device's backing resolution the game renders at. */
export function renderRes(): number {
  return value;
}

export function setRenderRes(v: number): void {
  const next = snapRenderRes(v);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  if (g.window && g.CustomEvent) g.window.dispatchEvent(new g.CustomEvent("ml-render-res", { detail: next }));
}

/* The slider: the top of the track is full resolution (where it stands today),
 * the stops are evenly spaced down the track. */
const LAST = RENDER_RES_STEPS.length - 1;
export const renderResFromSlider = (p: number): number => RENDER_RES_STEPS[LAST - Math.round(Math.max(0, Math.min(1, p)) * LAST)];
export const sliderFromRenderRes = (v: number): number => (LAST - RENDER_RES_STEPS.indexOf(snapRenderRes(v) as (typeof RENDER_RES_STEPS)[number])) / LAST;

/** The device's FULL backing size (CSS size × the capped devicePixelRatio),
 *  told by main.ts whenever the canvas is fitted — what the labels divide. */
let full = { w: 0, h: 0 };
export function setFullBacking(w: number, h: number): void {
  full = { w, h };
}
export function fullBacking(): { w: number; h: number } {
  return full;
}

/** `1/2`, `2/3`, `1/8`: the smallest denominator (up to 12) that names the
 *  fraction, else `1/k` — whole when it is (`1/50`), one decimal when not
 *  (`1/2.7`, the light dial's geometric steps). */
export function fractionText(frac: number): string {
  const f = Math.max(1e-6, frac);
  for (let b = 1; b <= 12; b++) {
    const a = Math.round(f * b);
    if (a >= 1 && Math.abs(f * b - a) < 0.005) return `${a}/${b}`;
  }
  const k = 1 / f;
  return `1/${Math.abs(k - Math.round(k)) < 0.05 ? String(Math.round(k)) : k.toFixed(1)}`;
}

/** `1/2 540×702` — a fraction of the FULL backing and the pixels it means. */
export function resFractionLabel(frac: number): string {
  const f = Math.max(1e-6, frac);
  const dims = full.w > 0 ? ` ${Math.round(full.w * f)}×${Math.round(full.h * f)}` : "";
  return `${fractionText(f)}${dims}`;
}

export function renderResLabel(v: number = value): string {
  return resFractionLabel(v);
}

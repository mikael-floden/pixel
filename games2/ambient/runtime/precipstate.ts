/* HOW MUCH PRECIPITATION IS ACTUALLY FALLING — one number, published by the
 * weather layer and read by the environment.
 *
 * `env.rain` ramps the rain-splash and damps six creatures (butterflies, fish,
 * gnats, dragonflies, chimney smoke) as the rain rolls in, so it must follow
 * the DRAWN density rather than the weather index: the index flips instantly,
 * the sheet fades in over ~4 s, and gating creatures on the index makes them
 * vanish before a drop is visible.
 *
 * It used to come from the game — `__ml.weatherInfo().precip.shown`, published
 * by WorldScene, which owned the layer. Ambient owns the layer now (maintainer
 * 2026-09-17), so that round-trip through the renderer is gone. This holder is
 * the seam that replaces it, and it lives in `runtime/` for the charter's
 * reason: `runtime/env.ts` may not import a feature, and a feature may not
 * import another feature, but both may use `runtime/`.
 *
 * Absent or stale (no weather feature stepped yet) reads as 0 — no rain, which
 * is the safe answer for every consumer. */

let shown = 0;

/** Called by the weather layer each frame with its live particle count. */
export function setPrecipShown(n: number): void {
  shown = Number.isFinite(n) && n > 0 ? n : 0;
}

/** Live particle count of the weather sheet, 0 when nothing is falling. */
export function precipShown(): number {
  return shown;
}

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

/* ONE NUMBER PER SHEET, since 2026-09-20: weather is per ZONE and a view can
 * hold two weathers (snow on the summit, storm on the massif beside it), so
 * each weather row draws its own sheet and publishes its own count. The
 * environment reads the STRONGEST — "how much is falling" for a creature that
 * hides from rain is the heaviest sheet in view. */
const shown = new Map<string, number>();

/** Called by a weather sheet each frame with its live particle count. */
export function setPrecipShown(name: string, n: number): void {
  if (Number.isFinite(n) && n > 0) shown.set(name, n);
  else shown.delete(name);
}

/** The heaviest live sheet's particle count, 0 when nothing is falling. */
export function precipShown(): number {
  let m = 0;
  for (const v of shown.values()) if (v > m) m = v;
  return m;
}

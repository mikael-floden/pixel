/** THE LIGHT FIELDS' RESOLUTION — a Settings slider (maintainer 2026-09-07:
 * "I can't use ?light=0.5. I need a button on the settings page. I have the
 * app installed on my Android home screen").
 *
 * One fraction of the canvas, 0.25..1, that the three full-screen passes
 * (light, mist, depth fog) render at before being upsampled LINEAR. Cost is
 * the SQUARE of it — 0.5 is a quarter of the fragments — because it scales
 * both axes. The passes sample everything normalised over uCam and Phaser sets
 * `resolution` to the shader's own size, so nothing else in the frame moves.
 *
 * Owned here rather than in nightlight.ts because the HUD writes it and the
 * renderer reads it, exactly like indoorlight.ts and hiddenring.ts — and
 * nightlight.ts pulls in Phaser, which the HUD must not. One localStorage key
 * (`ml-light-scale`, unchanged, so an installed PWA keeps whatever `?light=`
 * last set), one window event.
 *
 * A PWA installed to the home screen HAS NO URL BAR. Any dev A/B that only
 * exists as a query parameter is unreachable to the one person who tests this
 * game; `?light=` still works for a browser tab, but the slider is the real
 * control and every future knob gets one.
 */

const KEY = "ml-light-scale";

/** Full resolution. Lowering this is a measurement, not a default — the
 * maintainer picks the shipping value by eye after a beacon run. */
export const LIGHT_SCALE_DEFAULT = 1;

/** The slider's travel. Below a quarter the upsample smears a light's edge
 * into a visible staircase across a cliff face; above 1 there is nothing to
 * gain, the passes are already canvas-sized. */
export const LIGHT_SCALE_MIN = 0.25;
export const LIGHT_SCALE_MAX = 1;
/** Steps of 5% — fine enough to find the knee between speed and softness,
 * coarse enough to hit with a thumb. */
export const LIGHT_SCALE_STEP = 0.05;

const clamp = (v: number) =>
  v < LIGHT_SCALE_MIN ? LIGHT_SCALE_MIN : v > LIGHT_SCALE_MAX ? LIGHT_SCALE_MAX : v;

/** Snap to the step grid, then round the float — 0.35000000000000003 as a
 * localStorage string survives a reload and comes back off-grid forever. */
export const snapLightScale = (v: number) =>
  Math.round(clamp(Math.round(v / LIGHT_SCALE_STEP) * LIGHT_SCALE_STEP) * 100) / 100;

let value = load();

function load(): number {
  try {
    /* `?light=` STILL WINS AND WRITES THROUGH, so a browser tab can set the
     * scale for a home-screen PWA that shares the origin's storage. */
    const q = new URLSearchParams(location.search).get("light");
    if (q !== null) {
      const v = Number(q);
      if (Number.isFinite(v) && v > 0) {
        const s = snapLightScale(v);
        try {
          localStorage.setItem(KEY, String(s));
        } catch {
          /* storage disabled — honour the param for this session anyway */
        }
        return s;
      }
    }
    const v = Number(localStorage.getItem(KEY));
    if (Number.isFinite(v) && v > 0) return snapLightScale(v);
  } catch {
    /* storage/location blocked: full size */
  }
  return LIGHT_SCALE_DEFAULT;
}

/** The dial, 0.25..1 — the fraction of the canvas the light passes render at. */
export function lightScale(): number {
  return value;
}

export function setLightScale(v: number): void {
  const next = snapLightScale(v);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-light-scale", { detail: next }));
}

/** Slider readout. Names the side that matters — the fragment count, which is
 * the square — because 50% sounds like half the work and is a quarter of it. */
export function lightScaleLabel(v: number = value): string {
  if (v >= 1) return "100% (full)";
  return `${Math.round(v * 100)}% · ${Math.round(v * v * 100)}% of the pixels`;
}

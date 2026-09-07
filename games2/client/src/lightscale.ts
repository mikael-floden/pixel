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

/* REACHED THROUGH globalThis, not as bare globals. The curve here is pure and
 * is unit-tested under Node (server/test/lightscale.test.ts), which puts this
 * file in a project with no DOM lib — bare `location`/`window` do not compile
 * there, and the try/catch that already guards a private-mode browser guards
 * their absence too. */
const g = globalThis as unknown as {
  location?: { search: string };
  window?: { dispatchEvent(e: unknown): void };
  CustomEvent?: new (t: string, i?: { detail?: unknown }) => unknown;
};

/** HALF (maintainer 2026-09-07: "I think 50% is a perfect default"), picked by
 * eye against a measurement rather than either alone. Two of his beacon runs on
 * the same build, cooled between: 100% -> 50% moved fps 43.4 -> 48.7 (+12%),
 * frame p90 34.4 -> 28.0 ms, p99 73.8 -> 47.6 ms, while CPU work per frame was
 * flat at -3% and idle per frame fell 27% — the signature of a fragment-bound
 * frame, and the answer to whether his Mali-G715 is GPU-limited. It is. He
 * could not see 50% at all; 25% is where he first could. */
export const LIGHT_SCALE_DEFAULT = 0.5;

/** The slider's travel. The floor is deliberately absurd — at 2% of a 1079px
 * canvas the field is 22 texels wide, one per ~25 screen pixels, which is far
 * past anything shippable. That is the point: the maintainer went to the old
 * 25% floor and still saw nothing ("I can't see any difference... maybe I even
 * feel the game looks better"), so the slider has to reach somewhere he CAN
 * see it break or it cannot tell him where the knee is. Above 1 there is
 * nothing to gain; the passes are already canvas-sized. */
export const LIGHT_SCALE_MIN = 0.02;
export const LIGHT_SCALE_MAX = 1;

/** THE TRAVEL IS GEOMETRIC, not linear — each step is the same RATIO (~10%),
 * so half the slider lives below 14% where the interesting region is. Linear
 * travel would bury the whole hunt in the bottom fifth of the track, and it is
 * the ratio that matters anyway: 4%->8% is the same doubling of coarseness as
 * 40%->80%, while costing a fiftieth as much. 40 steps over a 50x range. */
export const LIGHT_SCALE_STEPS = 40;
const RATIO = LIGHT_SCALE_MAX / LIGHT_SCALE_MIN;

const clamp = (v: number) =>
  v < LIGHT_SCALE_MIN ? LIGHT_SCALE_MIN : v > LIGHT_SCALE_MAX ? LIGHT_SCALE_MAX : v;

/** Slider position 0..1 -> scale, and back. Exported so the HUD does not carry
 * its own copy of the curve. */
export const lightScaleFromSlider = (p: number) =>
  snapLightScale(LIGHT_SCALE_MIN * Math.pow(RATIO, p < 0 ? 0 : p > 1 ? 1 : p));
export const sliderFromLightScale = (v: number) =>
  Math.log(clamp(v) / LIGHT_SCALE_MIN) / Math.log(RATIO);

/** Snap to the geometric grid, then round the float — 0.35000000000000003 as a
 * localStorage string survives a reload and comes back off-grid forever. Three
 * decimals, because the low end needs them (0.024, 0.026) and a hashed-name
 * style exactness is not the point here, reproducibility is. */
export const snapLightScale = (v: number) => {
  const k = Math.round((Math.log(clamp(v) / LIGHT_SCALE_MIN) / Math.log(RATIO)) * LIGHT_SCALE_STEPS);
  return Math.round(LIGHT_SCALE_MIN * Math.pow(RATIO, k / LIGHT_SCALE_STEPS) * 1000) / 1000;
};

let value = load();

function load(): number {
  try {
    /* `?light=` STILL WINS AND WRITES THROUGH, so a browser tab can set the
     * scale for a home-screen PWA that shares the origin's storage. */
    const q = new URLSearchParams(g.location?.search ?? "").get("light");
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
  if (g.window && g.CustomEvent) g.window.dispatchEvent(new g.CustomEvent("ml-light-scale", { detail: next }));
}

/** Slider readout. Names the side that matters — the fragment count, which is
 * the square — because 50% sounds like half the work and is a quarter of it. */
export function lightScaleLabel(v: number = value): string {
  if (v >= 1) return "100% (full)";
  // One decimal under 10%, where whole percents would print three steps of the
  // slider as the same number.
  const pct = v * 100;
  const side = pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
  const area = v * v * 100;
  const frac = area < 1 ? area.toFixed(2) : area < 10 ? area.toFixed(1) : String(Math.round(area));
  return `${side}% · ${frac}% of the pixels`;
}

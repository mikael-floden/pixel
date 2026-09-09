/** THE TWO LIGHT-ANIMATION DIALS — how far a LIT clip's per-frame light data
 *  moves the light. The scenery domain publishes `light_frames` on every LIT
 *  animation (scenery/README.md, 2026-09-09): per frame an `intensity` relative
 *  to the clip's mean (0.5–1.5) and the emissive centroid's `dx`/`dy` from the
 *  frame centre in frame px. The game applies both while the clip plays
 *  (WorldScene.stepSceneryAnims), each scaled by a RATIO the maintainer sets
 *  here — "0.5 means half the effect and 2.0 means twice the effect ... 0.05 to
 *  20x. This is for me to test what looks best. Will give you the defaults once
 *  I found it." (2026-09-09). 1 is the data as published.
 *
 *  Same contract as sceneryanim.ts: this module owns the values and their
 *  persistence, the Settings sliders are the only writers, and the scene reads
 *  the ratios every frame — a drag shows on the next frame, no rebuild. */

export interface LightAnimTune {
  /** Multiplies the per-frame intensity SWING (intensity − 1). */
  intensity: number;
  /** Multiplies the per-frame centre OFFSET. */
  position: number;
}

export const LIGHT_ANIM_DEFAULT: LightAnimTune = { intensity: 1, position: 1 };
/** ratio = MIN * (MAX/MIN)^p — a log dial, 0.05..20, 1 near the middle. */
export const LIGHT_ANIM_MIN = 0.05;
export const LIGHT_ANIM_MAX = 20;

const KEY = "ml-light-anim";
let value: LightAnimTune = load();

function load(): LightAnimTune {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...LIGHT_ANIM_DEFAULT };
    const v = JSON.parse(raw) as Partial<LightAnimTune>;
    const num = (x: unknown, d: number) =>
      typeof x === "number" && Number.isFinite(x) ? Math.max(LIGHT_ANIM_MIN, Math.min(LIGHT_ANIM_MAX, x)) : d;
    return { intensity: num(v.intensity, LIGHT_ANIM_DEFAULT.intensity), position: num(v.position, LIGHT_ANIM_DEFAULT.position) };
  } catch {
    return { ...LIGHT_ANIM_DEFAULT };
  }
}

export function lightAnimTune(): LightAnimTune {
  return value;
}

export function setLightAnimTune(patch: Partial<LightAnimTune>): void {
  const next = { ...value, ...patch };
  if (next.intensity === value.intensity && next.position === value.position) return;
  value = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-light-anim", { detail: next }));
}

/* -- slider <-> ratio maps (the sliders are 0..1) --------------------------- */
export const ratioFromSlider = (p: number): number =>
  +(LIGHT_ANIM_MIN * Math.pow(LIGHT_ANIM_MAX / LIGHT_ANIM_MIN, Math.max(0, Math.min(1, p)))).toFixed(3);
export const sliderFromRatio = (r: number): number =>
  Math.log(Math.max(LIGHT_ANIM_MIN, Math.min(LIGHT_ANIM_MAX, r)) / LIGHT_ANIM_MIN) / Math.log(LIGHT_ANIM_MAX / LIGHT_ANIM_MIN);

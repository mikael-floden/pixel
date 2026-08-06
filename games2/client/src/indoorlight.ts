/** INDOOR BASE LIGHT — the Settings slider (maintainer 2026-08-06).
 *
 * "This slider should control the overall/base in-door ambient light
 * brightness. 0% = BLACK, 100% = THE TILE WILL LOOK JUST LIKE THE PNG (WEBP)."
 *
 * So the value is a straight 0..1 dial on the ambient the night shader
 * multiplies the world by, and both ends are exact by construction:
 *
 *   0    → [0, 0, 0]  — no light at all, the interior is pure black
 *   1    → [1, 1, 1]  — the multiply is the identity, so every tile renders
 *                       EXACTLY as its source art (that is what "just like the
 *                       PNG" means: uAmbient 1 is authored brightness)
 *
 * Owned here rather than in WorldScene or hud.ts because both need it: the HUD
 * writes it, the renderer reads it every frame, and it has to survive a reload.
 * Same shape as controls.ts (handedness): one localStorage key, one window
 * event, no imports either way.
 */

const KEY = "ml-indoor-light";

/** Default = the grade that shipped before the slider existed.
 *
 * It is 0.104 and not a round number on purpose: INDOOR_AMBIENT was
 * [0.086, 0.09, 0.104], and since the hue below is that triple normalised to
 * max 1, a dial of 0.104 reproduces it to the last decimal. So the slider
 * arrives at exactly today's look and moves from there — nobody's world
 * changes brightness the moment this ships. */
export const INDOOR_LIGHT_DEFAULT = 0.104;

/** The indoor HUE, as ratios (the tuned triple over its own max).
 *
 * Derived in WorldScene from TIME_PHASES[0] Night [0.075, 0.09, 0.14] by
 * holding luminance and rotating the hue about green — night-dark but with 76%
 * of the blue tilt gone, because unlit stone and wood are cool while a warm
 * cast would read as if a fire were already lit. Kept as RATIOS so the slider
 * scales brightness WITHOUT touching the colour that was tuned. */
const HUE: readonly [number, number, number] = [0.086 / 0.104, 0.09 / 0.104, 1];

let value = load();

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return INDOOR_LIGHT_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clamp01(v) : INDOOR_LIGHT_DEFAULT;
  } catch {
    return INDOOR_LIGHT_DEFAULT; // private mode / storage disabled
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The dial, 0..1. */
export function indoorLight(): number {
  return value;
}

/** Set the dial and tell the renderer. Fires "ml-indoor-light" so the scene
 * picks it up on its next frame — no polling, and the slider stays the single
 * writer. */
export function setIndoorLight(v: number): void {
  const next = clamp01(v);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-indoor-light", { detail: next }));
}

/**
 * The ambient triple for the current dial.
 *
 * `t * (HUE + (1 - HUE) * t²)` — brightness is linear in the dial, and the
 * tuned cool tint fades out QUADRATICALLY as it opens up, so:
 *
 *   • at the dark end the interior keeps the colour that was tuned for it
 *     (at the 0.104 default the tint is intact: B/R 1.21, as before),
 *   • at 1 the tint is gone and the triple is exactly [1, 1, 1], which is the
 *     maintainer's "looks just like the PNG" — a hue-tinted 100% would render
 *     every tile slightly blue and would NOT be the source art.
 *
 * The quadratic is what buys both: a linear fade would have washed the tint out
 * by half-way, where the room is still meant to read as an interior.
 */
export function indoorAmbient(): [number, number, number] {
  const t = value;
  const k = t * t;
  return [
    t * (HUE[0] + (1 - HUE[0]) * k),
    t * (HUE[1] + (1 - HUE[1]) * k),
    t * (HUE[2] + (1 - HUE[2]) * k),
  ];
}

/** Percent for the slider's readout. */
export function indoorLightLabel(): string {
  return `${Math.round(value * 100)}%`;
}

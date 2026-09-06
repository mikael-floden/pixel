/** THE HIDDEN-BEHIND OUTLINE'S STRENGTH — a Settings slider (maintainer
 * 2026-09-07: "the wall-hack feature makes objects pop a bit too much. The
 * idea is to be able to see the objects behind the wall, not see them way
 * better when behind the wall").
 *
 * One 0..1 opacity on the white silhouette WorldScene draws over the covered
 * part of a body (syncCoverOutline). 1 is the old flat look; 0 switches the
 * wall-hack off entirely. It is deliberately a separate knob from
 * RING_LIGHT_FLOOR, which decides how far the ring tracks the LIGHT at the
 * body's own spot — that one keeps the line from going black after sunset,
 * this one decides how loud the line is at all.
 *
 * Owned here rather than in WorldScene or hud.ts because both need it, exactly
 * like indoorlight.ts: the HUD writes it, the renderer reads it per frame, and
 * it has to survive a reload. One localStorage key, one window event.
 */

const KEY = "ml-hidden-ring";

/** Default 60% — a first dim, not a tuned number: the maintainer asked for the
 * slider so he can pick the real one by eye and tell us ("I will then tell you
 * what the default value should be"). Do not treat this as his verdict. */
export const HIDDEN_RING_DEFAULT = 0.6;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

let value = load();

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return HIDDEN_RING_DEFAULT;
    const v = Number(raw);
    return Number.isFinite(v) ? clamp01(v) : HIDDEN_RING_DEFAULT;
  } catch {
    return HIDDEN_RING_DEFAULT; // private mode / storage disabled
  }
}

/** The dial, 0..1 — the outline's opacity. */
export function hiddenRing(): number {
  return value;
}

export function setHiddenRing(v: number): void {
  const next = clamp01(v);
  if (next === value) return;
  value = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    /* storage disabled — the setting simply does not persist */
  }
  window.dispatchEvent(new CustomEvent("ml-hidden-ring", { detail: next }));
}

/** Percent for the slider's readout. */
export function hiddenRingLabel(): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Handedness — which side the analog stick lives on (maintainer 2026-08-05,
 * with landscape support): RIGHT-handed is the default and means the stick is
 * on the RIGHT in every orientation (exactly where portrait has always had
 * it); LEFT-handed mirrors it to the left. In landscape the whole HUD column
 * follows: the menu takes the side OPPOSITE the stick, so the tab buttons are
 * always under the other thumb.
 *
 * One tiny module so the consumers can't drift: hud.ts (menu side + the
 * Settings "controls" button), gamepad.ts (stick/jump placement), and the
 * `__ml.hand` QA probe all read the same source. Persisted in localStorage;
 * every change dispatches "ml-hand" on window — layout code re-anchors from
 * that one event.
 */

export type Hand = "right" | "left";

const KEY = "ml-hand";

export function getHand(): Hand {
  try {
    return localStorage.getItem(KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

export function setHand(h: Hand): Hand {
  try {
    localStorage.setItem(KEY, h);
  } catch {}
  window.dispatchEvent(new Event("ml-hand"));
  return h;
}

export function toggleHand(): Hand {
  return setHand(getHand() === "right" ? "left" : "right");
}

/** The Settings button's printed state. */
export function handLabel(): string {
  return getHand() === "right" ? "right-handed" : "left-handed";
}

/* ── THE STICK'S FINE-TUNE (maintainer 2026-09-19: "a new control to be able
 * to fine-tune the analog stick location … the control (x and y slider)
 * should have a ± half radius in player control … margin 0 is the min so the
 * stick can never be rendered outside of screen/div"). A nudge in css px,
 * SCREEN space: +x toward the right edge of the screen, +y up. Stored raw;
 * gamepad.ts clamps it to ± half the live well's radius (the tier changes
 * with the viewport) and floors the margin to the game view's edge at 0 when
 * it applies it, so the same two numbers hold in both orientations. One
 * event, "ml-stick", and the stick re-lays itself out. ── */
export interface StickNudge {
  x: number;
  y: number;
}
const NUDGE_KEY = "ml-stick-nudge";
/** A sanity bound on what is STORED (the live clamp is the well's); a bad
 * value in localStorage reads as 0, never as a stick off the screen. */
const NUDGE_STORE_MAX = 64;

const clampNudge = (v: unknown): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(-NUDGE_STORE_MAX, Math.min(NUDGE_STORE_MAX, n));
};

export function stickNudge(): StickNudge {
  try {
    const v = JSON.parse(localStorage.getItem(NUDGE_KEY) || "{}") as Partial<StickNudge>;
    return { x: clampNudge(v.x), y: clampNudge(v.y) };
  } catch {
    return { x: 0, y: 0 };
  }
}

export function setStickNudge(next: Partial<StickNudge>): StickNudge {
  const cur = stickNudge();
  const n = { x: clampNudge(next.x ?? cur.x), y: clampNudge(next.y ?? cur.y) };
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify(n));
  } catch {}
  window.dispatchEvent(new Event("ml-stick"));
  return n;
}

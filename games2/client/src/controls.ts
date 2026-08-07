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

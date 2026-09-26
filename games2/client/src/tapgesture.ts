// THE DOUBLE TAP, ONE JUDGE (maintainer 2026-09-26: "To navigate to a
// position/marker the player will need to double tap! This frees up the swipe
// input in the game view!"). A ground trip starts on the SECOND tap
// (WorldScene's pointerdown), and a one-finger swipe on the world turns the
// view (spinbar.ts). Both ask THIS module about the touch-down in hand, so what
// the world calls a double tap is never also judged a swipe.
//
// It judges on the document's CAPTURE pointerdown, which runs before the game
// hears the touch (a pointerdown precedes Phaser's touch/mouse listeners and
// any canvas listener), and only touch-downs on the game canvas count.

/** Longest gap between the two touch-downs. */
export const DOUBLE_TAP_MS = 350;
/** Farthest the second touch-down may land from the first (css px). */
export const DOUBLE_TAP_PX = 48;

let last: { t: number; x: number; y: number } | null = null;
let second = false;

function onDown(e: PointerEvent): void {
  const t = e.target;
  if (!(t instanceof HTMLCanvasElement) || !t.closest("#game")) return;
  const prev = last;
  second = !!prev && e.timeStamp - prev.t <= DOUBLE_TAP_MS &&
    Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_TAP_PX;
  // a triple tap is a double and then a fresh first
  last = second ? null : { t: e.timeStamp, x: e.clientX, y: e.clientY };
}
if (typeof document !== "undefined")
  document.addEventListener("pointerdown", onDown, { capture: true, passive: true });

/** Was the latest touch-down on the world the SECOND of a double tap? */
export function isSecondTap(): boolean {
  return second;
}

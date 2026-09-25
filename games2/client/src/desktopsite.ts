/** THE "DESKTOP SITE" SQUEEZE — a phone browser laying the page out on a
 *  ~980 CSS px desktop viewport and shrinking it onto the screen (Chrome's
 *  "Desktop site", Samsung Internet's "Desktop version"). The viewport meta is
 *  ignored there, so every CSS px is ~0.45 of a device-width phone's: the DOM
 *  UI is drawn at half the size it has on his phone, and a canvas backed at
 *  devicePixelRatio per CSS px is backed at ~2.2x the screen's real pixels
 *  (maintainer 2026-09-25, his girlfriend's phone: "The UI is super small ...
 *  the resolution had to be lowered (was way overkill as default)". Measured
 *  off her screenshots: backing 2390 x 3912, world zoom 5 — only a ~980 px
 *  layout at dpr ~2.44 gives both; his phone is 484 px at dpr 2.23).
 *
 *  THE FIX IS HERS TO FLIP, SO THE GAME SAYS SO: the UI is plain responsive
 *  CSS by law (UI_AGENT.md: no zoom compensation), so it cannot be un-squeezed
 *  from inside without patching every place that mixes element rects with the
 *  window's size. What the game does on its own: the canvas backs at the
 *  screen's REAL pixels (main.ts `rsFull`), which also makes the camera's
 *  integer zoom land where his does (540 world px across), and a notice
 *  (desktopsitenotice.ts) tells the player how to turn the mode off. Node-safe
 *  and DOM-free: the tests import it. */

export interface SqueezeEnv {
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
  touch: boolean;
}

/** A layout this much wider than the screen is a desktop viewport, not a
 *  rounding: his own phone's landscape viewport runs 1.16x its screen's long
 *  side (UI_AGENT.md, 988 on 851) and must stay untouched. */
export const SQUEEZE_MIN = 1.25;

const g = globalThis as unknown as {
  innerWidth?: number;
  innerHeight?: number;
  screen?: { width: number; height: number };
  navigator?: { maxTouchPoints?: number };
  matchMedia?: (q: string) => { matches: boolean };
};

/** The live page's numbers, or null off a browser. */
export function liveEnv(): SqueezeEnv | null {
  if (!g.screen || g.innerWidth === undefined || g.innerHeight === undefined) return null;
  const touch = (g.navigator?.maxTouchPoints || 0) > 0 || g.matchMedia?.("(pointer: coarse)").matches === true;
  return {
    innerWidth: g.innerWidth,
    innerHeight: g.innerHeight,
    screenWidth: g.screen.width,
    screenHeight: g.screen.height,
    touch,
  };
}

/** How many layout CSS px fall on one of the screen's own CSS px: 1 on a
 *  device-width page, a desktop or anything without touch; ~2.2 on a phone in
 *  "Desktop site". Measured against the screen side that runs across the
 *  current orientation. */
export function desktopSqueeze(env: SqueezeEnv | null = liveEnv()): number {
  if (!env || !env.touch || env.screenWidth <= 0 || env.screenHeight <= 0) return 1;
  const portrait = env.innerHeight >= env.innerWidth;
  const across = portrait ? Math.min(env.screenWidth, env.screenHeight) : Math.max(env.screenWidth, env.screenHeight);
  const k = env.innerWidth / across;
  return k >= SQUEEZE_MIN ? k : 1;
}

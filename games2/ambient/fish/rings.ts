/* FISH RISES — the pure half. No Phaser, no DOM: the ring geometry and the
 * whole timeline of one rise are arithmetic here so `server/test/fish.test.ts`
 * can pin them, and fish.ts only pools sprites and reads the clock.
 *
 * A RING ON THIS GROUND IS AN ELLIPSE. The iso projection maps a world circle
 * to a screen ellipse squashed by dy/dx = 14/32, and a rise drawing a circle
 * would read as a hoop standing up out of the lake. Same arithmetic the game
 * uses for a body's shadow ellipse; the ratio is the projection's, not taste.
 *
 * Pixel art rules apply: every ring is rasterised at a WHOLE-PIXEL radius and
 * drawn at scale 1 on integer positions, so a growing ring steps radius by
 * radius rather than sliding sub-pixel. That is also why the frames are a
 * handful of small textures generated once, not one texture scaled up.
 */

/** Screen squash of the iso projection: ISO_DY / ISO_DX. */
export const RING_RY = 14 / 32;

/** A ring's life, and how far it gets. RMAX is about half a cell across: a
 *  rise is a fish taking a fly, not a stone thrown in. */
export const RING_LIFE = 1500;
export const RING_R0 = 2;
export const RING_RMAX = 15;
/** How long the fish's own back is out of the water, and the tail flick after. */
export const BACK_MS = 170;
export const FLICK_MS = 110;
/** Splash specks (the bigger rises only). */
export const SPLASH_MS = 420;
export const SPLASH_N = 5;

/** When each ring of a rise is born, in ms from the rise. A quiet rise makes
 *  two; a splashy one makes three. Spaced widely because the radius curve
 *  decelerates: rings born close together arrive at the same place and read
 *  as one thick blob rather than as a ripple. */
export function ringBirths(splashy: boolean): readonly number[] {
  return splashy ? [40, 330, 700] : [40, 330];
}

/** THE LEAD RING IS THE BIG ONE. Each ring after it is smaller and fainter,
 *  which is both what water does and what keeps nested rings legible: three
 *  rings of equal reach pile onto each other as they slow. */
const RING_FALL = 0.26;
export function ringScale(k: number): number {
  return Math.max(0.3, 1 - RING_FALL * k);
}

/** Total life of a rise, so the pool can retire it without asking. */
export function riseLife(splashy: boolean): number {
  const b = ringBirths(splashy);
  return b[b.length - 1] + RING_LIFE;
}

/** THE RING'S RADIUS AT AN AGE, in world px along x. Slightly decelerating:
 *  a real ripple leaves fast and slows as it spreads. Whole pixels only. */
export function ringR(age: number, k = 0): number {
  const t = Math.max(0, Math.min(1, age / RING_LIFE));
  return Math.max(RING_R0, Math.round((RING_R0 + (RING_RMAX - RING_R0) * Math.pow(t, 0.65)) * ringScale(k)));
}

/** ...and its opacity: a quick attack so it appears as a line rather than
 *  fading in, then a long decay to nothing. 0 once the ring is over. */
export function ringAlpha(age: number, k = 0): number {
  if (age < 0 || age >= RING_LIFE) return 0;
  const t = age / RING_LIFE;
  const attack = Math.min(1, t / 0.1);
  return attack * Math.pow(1 - t, 1.3) * ringScale(k);
}

/** The fish's back: out of the water for BACK_MS, gone after. */
export function backAlpha(age: number): number {
  if (age < 0 || age >= BACK_MS) return 0;
  const t = age / BACK_MS;
  return t < 0.25 ? t / 0.25 : Math.pow(1 - (t - 0.25) / 0.75, 0.8);
}

/** The tail flick, a beat after the back goes under. */
export function flickAlpha(age: number): number {
  const a = age - BACK_MS;
  if (a < 0 || a >= FLICK_MS) return 0;
  return Math.pow(1 - a / FLICK_MS, 0.7);
}

/** One splash speck of a splashy rise: where it is relative to the rise, and
 *  whether it is still in the air. Thrown up and out, pulled back down —
 *  whole pixels, so it hops rather than glides. */
export function splashAt(i: number, age: number): { dx: number; dy: number; alive: boolean } {
  const a = age - 60;
  if (a < 0 || a >= SPLASH_MS) return { dx: 0, dy: 0, alive: false };
  const t = a / SPLASH_MS;
  // fan the specks left and right, alternating, the middle one straight up
  const side = i % 2 === 0 ? 1 : -1;
  const spread = (1 + Math.floor(i / 2)) * 1.7 * side;
  // a speck thrown further out goes less high, but every one of them still
  // clears the surface: at 0.5 the outermost peaked two pixels up and read as
  // a stationary dot rather than a splash
  const up = 6 - Math.abs(spread) * 0.25;
  return {
    dx: Math.round(spread * t * 2.2),
    // up then down: a parabola in screen y, squashed like everything else
    dy: -Math.round(up * (t * 2 - t * t * 2.6) * 2),
    alive: true,
  };
}

/** The 1-px outline of an iso ellipse of x-radius `rx`, as offsets from its
 *  centre. Closed and 8-connected: sampled along BOTH axes and unioned, so
 *  there is no gap where the curve turns (a single-axis sweep leaves the top
 *  and bottom of a flat ellipse open). */
export function ellipsePixels(rx: number): { ry: number; px: [number, number][] } {
  const ry = Math.max(1, Math.round(rx * RING_RY));
  const seen = new Set<number>();
  const px: [number, number][] = [];
  const put = (x: number, y: number) => {
    const k = (x + 64) * 256 + (y + 64);
    if (seen.has(k)) return;
    seen.add(k);
    px.push([x, y]);
  };
  for (let x = -rx; x <= rx; x++) {
    const y = Math.round(ry * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2)));
    put(x, y);
    put(x, -y);
  }
  for (let y = -ry; y <= ry; y++) {
    const x = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y / ry) ** 2)));
    put(x, y);
    put(-x, y);
  }
  return { ry, px };
}

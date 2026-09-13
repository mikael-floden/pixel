/* DAWN MIST IN THE HOLLOWS — the pure half. No Phaser, no DOM: where mist
 * belongs, how thick it is there, what one patch of it does over its life and
 * when the sun burns it off are arithmetic here so `server/test/dawnmist.test.ts`
 * can pin them, and dawnmist.ts only pools sprites and reads the clock.
 *
 * WHERE IT BELONGS IS A FIELD, NOT A PLACE. The first cut of this was "low
 * ground near water", and measuring the_game before writing a line is what
 * killed it: 4,363 of its cells are hollows (a ring of samples at 3 cells,
 * half of them higher), which is 3.5% of the land and exactly the right
 * rarity — but ALSO requiring still water within 4 cells leaves 509, which
 * would have tied the whole effect to one riverbank. So dampness is a NUMBER:
 * how enclosed a spot is, plus a bonus for water beside it. A deep hollow with
 * a pond in it is thick, a flat bank is a wisp, a ridge is nothing, and the
 * density falls off on its own at the edges instead of stopping at a line.
 *
 * IT IS NOT THE WEATHER'S MIST. The game already has a screen-wide mist pass
 * on weather 2; this is a LOCAL thing lying in a dip, and the two are told
 * apart by where they are rather than by what they look like. They also
 * disagree about the sky on purpose: radiation fog forms on CLEAR, still
 * nights — cloud is a blanket that stops the ground radiating — so this one
 * THINS as the cloud comes in, which is the opposite of what a mist effect
 * would do if it were just more weather.
 *
 * AND IT IS DRAWN UNDER THE DARKNESS OVERLAY, which is most of why it reads as
 * dawn at all. Every crawler in this folder sits ABOVE the overlay so its own
 * colour survives the night; mist must do the reverse. Lying in the surface
 * band means the night multiplies it exactly as it multiplies the ground it
 * lies on, so it is a faint pale-grey at 3am, catches the first light with the
 * rest of the world, and burns away as the sun climbs. Nothing here has to
 * model that — it is what being under the overlay gives for free.
 */

/** One patch's life. Long: fog does not flicker. */
export const PATCH_LIFE: [number, number] = [9000, 20000];
/** Gap between placement attempts while a view is under its target. */
export const GAP_MS: [number, number] = [400, 900];
/** THE CLOUD LAYER'S WIND (~42, 23 px/s), of which mist takes almost nothing:
 *  a bank that visibly slides is steam, not fog. Over a full life this is
 *  about one cell of travel. */
export const WIND_X = 42 * 0.06;
export const WIND_Y = 23 * 0.06;
/** ...and a slow breath on top, so a still bank is never a still IMAGE. */
export const BREATHE_MS: [number, number] = [4200, 9000];
export const BREATHE = 0.25;
/** The patch sizes, x-radius in px. `ry` is always RING_RY of these — a patch
 *  is a shape lying ON the ground, so it takes the projection's squash like
 *  every other ground shape in this folder. */
export const PATCH_RX = [18, 26, 36] as const;
/** How many patches one view may hold, and how many one spot may carry. */
export const MAX_PATCHES = 28;
export const PER_SPOT = 4;
/** Below this a spot is not damp enough to fog at all. */
export const MIN_DAMP = 0.3;
/** Still water beside a spot is worth this much dampness on its own, so a flat
 *  bank fogs thinly while a dry plain does not fog at all. */
export const WATER_BONUS = 0.35;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** HOW ENCLOSED A SPOT IS, 0..1, from the levels sampled in a ring around it.
 *  One level of rise already encloses at this scale (a level is most of a
 *  person), so a ring standing two levels up counts full. Partial credit is
 *  the point: the foot of a cliff has half its ring in the air and half
 *  against the wall, and that is exactly where fog gathers.
 *
 *  AND IT DRAINS. Cold air needs somewhere to come FROM and nowhere to go, so
 *  ground that falls away is counted AGAINST the spot — without that term a
 *  terrace halfway up a slope scores the same 0.5 as a cliff foot, when in
 *  fact the air on it pours off the downhill side. (Measured on the_game: the
 *  fogged share of the land goes 10.43% -> 8.76%, and every hollow and summit
 *  the gate stands on is unchanged. The ledges on the massif are what it
 *  removes, which is the whole point.) */
export function basin(centre: number, ring: number[]): number {
  if (!ring.length) return 0;
  let up = 0;
  let down = 0;
  for (const l of ring) {
    up += clamp01((l - centre) / 2);
    down += clamp01((centre - l) / 2);
  }
  return clamp01((up - down) / ring.length);
}

/** HOW FAR THE WORLD FALLS AWAY around a spot, 0..1, from levels sampled much
 *  further out than `basin`'s ring — and this is the term that tells a VALLEY
 *  from a POCKET ON A SUMMIT.
 *
 *  Enclosure alone cannot: a hollow beside an outcrop on a 46-level peak has
 *  the same ring as a hollow in a river bottom, and the gate caught exactly
 *  that (7 banks within four cells of a player standing on the world's highest
 *  ridge). What separates them is where the cold air GOES — off the massif in
 *  one case, nowhere in the other — and that is only visible from further out.
 *  Saturates at DRAIN_LEVELS of fall, so a real valley wall does not read as a
 *  drop. (Measured on the_game: the fogged share of the land goes 8.76% ->
 *  6.86%, both summit cells go to drain 1.0, and the three hollows the gate
 *  stands in keep 0.46-0.97.) */
export const DRAIN_LEVELS = 6;
export function drain(centre: number, far: number[]): number {
  if (!far.length) return 0;
  let s = 0;
  for (const l of far) s += clamp01((centre - l) / DRAIN_LEVELS);
  return clamp01(s / far.length);
}

/** ...and the dampness that follows: enclosed, damp, and with nowhere to
 *  drain to. The drain scales the WHOLE thing, water bonus included — a tarn
 *  on a peak is still a peak. */
export function damp(basinV: number, waterNear: boolean, drainV = 0): number {
  return clamp01((clamp01(basinV) + (waterNear ? WATER_BONUS : 0)) * (1 - clamp01(drainV)));
}

/** THE SUN BURNS IT OFF. Full while the sun is still under the horizon or just
 *  over it, gone by mid-morning — and the phase says which end of the day this
 *  is, because he asked for DAWN. It is thickest at night (fog forms in the
 *  small hours and this is honest about that), but night is also when nothing
 *  can be seen; the picture he asked for is the one at first light, when the
 *  bank is already there and the sun has arrived to show it.
 *
 *  CLOUD THINS IT: see the header — a clear sky is what makes the ground cold
 *  enough to fog, so this is the one effect here that prefers fine weather.
 *  Rain beats it down. */
export function weight(sun: number, phase: string, cloud: number, rain: number): number {
  const burn = 1 - clamp01((clamp01(sun) - 0.2) / 0.4); // 1 to sun .2, 0 by .6
  const hour = phase === "Morning" ? 1 : phase === "Night" ? 0.75 : phase === "Evening" ? 0.4 : 0.15;
  const clear = 1 - 0.65 * clamp01(cloud);
  return clamp01(burn * hour * clear * (1 - clamp01(rain)));
}

/** A patch thickens, holds, and thins away. The fades are a fifth of its life
 *  at each end — a bank that appears is a bank you saw appear. */
export function patchAlpha(age: number, life: number): number {
  if (age < 0 || age >= life) return 0;
  const t = age / life;
  if (t < 0.2) return t / 0.2;
  if (t > 0.8) return (1 - t) / 0.2;
  return 1;
}

/** ...breathing while it holds, so a still bank is never a still image. */
export function breathe(age: number, period: number, phase: number): number {
  return 1 - BREATHE * 0.5 * (1 - Math.cos(phase + (Math.max(0, age) / Math.max(1, period)) * Math.PI * 2));
}

/** Where a patch has drifted to after `age` ms. */
export function driftX(age: number): number {
  return (WIND_X * Math.max(0, age)) / 1000;
}
export function driftY(age: number): number {
  return (WIND_Y * Math.max(0, age)) / 1000;
}

/** Which size a spot of this dampness gets: a thin bank is small patches, a
 *  deep hollow is the big ones. Index into PATCH_RX. */
export function sizeFor(dampV: number, rnd: () => number): number {
  const lift = clamp01((dampV - MIN_DAMP) / (1 - MIN_DAMP));
  const r = rnd() * 0.55 + lift * 0.65;
  return r > 0.85 ? 2 : r > 0.45 ? 1 : 0;
}

/** How many patches a spot of this dampness carries. */
export function countFor(dampV: number): number {
  return Math.max(1, Math.round(PER_SPOT * clamp01((clamp01(dampV) - MIN_DAMP) / (1 - MIN_DAMP)) + 1));
}

export function nextGap(rnd: () => number): number {
  return GAP_MS[0] + rnd() * (GAP_MS[1] - GAP_MS[0]);
}

/* ---- the mark ------------------------------------------------------------- */

/** A stable value in [0,1) for a pixel of a patch — murmur3's finalizer over
 *  the coordinate and the patch's seed, so a texture is the same every time it
 *  is built and a test can pin it. */
export function hash01(x: number, y: number, seed: number): number {
  let h = (((x + 512) * 73856093) ^ ((y + 512) * 19349663) ^ (seed * 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** THE PATCH IS DITHERED, NOT BLURRED. There is no soft edge in this game —
 *  every mark is whole pixels at scale 1 — so density does the work a gradient
 *  would do elsewhere: a pixel is IN the patch with a probability that falls
 *  from the middle to the rim, which is the same trick the tiles domain's own
 *  shading uses and the only one that stays pixel art. Several of these
 *  overlapping at low alpha is what makes a bank rather than a blob.
 *
 *  Returns offsets from the centre of an iso-squashed ellipse (`ry` is the
 *  caller's, from RING_RY — the projection's squash, not taste). */
export function ditherPixels(rx: number, ry: number, seed: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = -ry; y <= ry; y++)
    for (let x = -rx; x <= rx; x++) {
      const t = Math.sqrt((x / rx) ** 2 + (y / ry) ** 2);
      if (t > 1) continue;
      // Dense in the middle, thinning to nothing at the rim — and never a
      // solid core, or the patch reads as a puddle.
      if (hash01(x, y, seed) < 0.86 * (1 - t * t)) out.push([x, y]);
    }
  return out;
}

/** HOW OPAQUE A PATCH IS AT THIS HOUR — and it is THICKER IN THE DARK, which
 *  looks backwards until you remember where this is drawn. The surface band is
 *  under the darkness overlay, so the night multiplies the mist by the same
 *  factor as the ground beneath it: the two keep their RATIO and lose their
 *  DIFFERENCE, and the fog quietly vanishes at exactly the hour it is
 *  thickest. Measured in the world's deepest hollow at night: the banks covered
 *  9.37% of the game area and moved those pixels by 3-9 luma.
 *
 *  So the opacity compensates for the multiply instead of the depth being
 *  given up. Everything the surface band buys is kept — the fog goes under
 *  bodies, it never glows, it takes the cliff's own shadow — and what it cost
 *  is paid back here, in the one number that can pay it. */
export const NIGHT_LIFT = 1.2;
export function alphaFor(base: number, sun: number): number {
  return clamp01(base * (1 + NIGHT_LIFT * (1 - clamp01(sun))));
}

/** THE COLOUR, and it does NOT change with the sun. A pale, barely-cool grey:
 *  a warm one reads as dust and a blue one as a magic effect, and the
 *  background palette law caps the saturation of anything this big anyway
 *  (this measures 0.04). The DAWN is not painted here — the night shader
 *  grades the surface band, so the same grey is near-black at 3am and catches
 *  the first light with the ground around it. */
export const MIST = 0xd8dee2;

/* CHIMNEY SMOKE — the pure half. No Phaser, no DOM: what one puff does between
 * leaving the flue and thinning away, and how hard the hearth under it is
 * burning, are arithmetic here so `server/test/chimney.test.ts` can pin them,
 * and chimney.ts only pools sprites and reads the clock.
 *
 * WHY THIS IS NOT smoke/plume.ts. A campfire wisp and a hearth plume are two
 * different things and the folder keeps a model per effect for exactly this
 * reason — every curve below differs from the campfire's, not just its
 * constants:
 *  - A HEARTH NEVER STOPS AND IT BREATHES. A fire in a house is fed and dies
 *    back over tens of seconds, so the column thickens and thins on its own
 *    slow cycle (`stoke`). A campfire has no such cycle; a chimney without one
 *    is a smoke machine.
 *  - IT BENDS OVER AS IT CLIMBS. A wisp at ground level is in still air; a
 *    plume clears the roofline into moving air, so the wind's share GROWS with
 *    height. That lean is what reads as a chimney from across the town, and a
 *    column that leans the same amount all the way up reads as a post.
 *  - IT ONLY EVER GETS BIGGER. Campfire smoke gathers and falls apart (3 px
 *    back to 1). A plume out of a hole expands monotonically and dies by
 *    THINNING — `puffSize` never decreases, which the test pins.
 *
 * AND IT IS TWO-TONE, which is the whole reason it can be seen at all. The
 * campfire's one grey works because 44 of the 51 open fires stand on open
 * ground: one background, so one departure from it. A chimney's plume crosses
 * its OWN ROOF and then the sky and ground beyond, and the_game's eleven roof
 * decks are surfaced snow (241 luma), grey_paving_stone (168), grey_stone
 * (128), parquet_floor (127) and brown_paving_stone (116), over grass at 61.
 * No single grey departs from 241 AND from 61. So a puff is drawn with a PALE
 * CORE and a RIM at RIM_MIX of it (baked into the texture, scaled by one
 * tint): over snow the rim carries it, over grass the core does. The lava
 * pool's rule — two departures from the background, and neither can be lost in
 * it — in the one place where the background is not even constant within a
 * single mark.
 */

/** How long one puff is in the air: much longer than a campfire's 1.8-3.2 s —
 *  a plume has to climb clear of a roof and still be there. */
export const PUFF_LIFE: [number, number] = [3400, 4800];
/** Rise in px/s AT THE MOUTH, and the share of that still left at the end.
 *  Slower than a flame's: this gas has already given up its heat to a flue.
 *
 *  THE COLUMN GROWS WITH THE MARKS. At 13 px a plume climbing 45 px was three
 *  puffs tall and read as a line; at 27 px the same climb is TWO, which is a
 *  lump sitting on the chimney rather than a column leaving it. Tripling the
 *  mark without raising the climb would have undone the size increase it was
 *  meant to deliver, so the rise comes up with it: the SHORTEST-lived puff now
 *  climbs 74 px for a 27 px mark, which the unit test holds at 2.5 mark-heights
 *  (the first attempt at this set 26 and the test caught 64 against a required
 *  68 — the size increase was quietly undoing itself). The top of the band is
 *  held DOWN rather than up for the same reason in reverse: at 46 px/s the
 *  longest-lived puff climbed 180 px, which is most of the game area. */
export const RISE0: [number, number] = [30, 38];
export const RISE_DRAG = 0.45;
/** The curl — wider and slower than a campfire's, and it OPENS with height. */
export const CURL_PX: [number, number] = [3, 7];
export const CURL_HZ: [number, number] = [0.14, 0.32];
/** How far the column opens out by the end of a puff's life, in px either
 *  side. Tight at the mouth (a flue is a hole), loose at the top. */
export const SPREAD_PX = 6;
/** THE CLOUD LAYER'S WIND, the same heading the pollen, leaves and campfire
 *  smoke drift on (~42, 23 px/s in the weather shader). A chimney takes a
 *  slightly bigger share than a campfire's 0.22 because it is up in it — but
 *  only slightly, and the first cut (0.34) was measured wrong in a way a
 *  screenshot would have missed: a plume leaning 47 px sideways against 44 up
 *  travels over the NEIGHBOURING roof while still pinned to its own stack's
 *  lit depth, so it draws over a house it is not coming out of. What makes it
 *  read as a chimney is the RAMP below, not the total. */
export const WIND_X = 42 * 0.24;
export const WIND_Y = 23 * 0.12;
/** Gap between puffs from one flue, before the stoke shortens it. */
export const GAP_MS: [number, number] = [150, 280];
/** THE PUFF RADII, in px — and they are sized against the HOLE, which is the
 *  thing a puff has to look like it came out of (maintainer 2026-09-14: "the
 *  smoke puff particles should be a little bigger, they are a bit small right
 *  now compared to the chimney hole"). Measured on the shipped art at the
 *  published vent: the flue mouth runs 10-12 px across on the narrow stacks
 *  (chimney_002 10 px on a 28 px stack, chimney_007 12 on 35), and scenery is
 *  drawn one art pixel to one player pixel. The first cut topped out at a FOUR
 *  pixel mark, about a third of the mouth, which is what he saw.
 *  A puff leaves at about the mouth's own width and then billows WELL past it
 *  — 9 px at the flue, 27 by the top. Twice he has called these too small
 *  (2026-09-14, on marks that ran 1-4 px and then 5-13), and the reason the
 *  first correction did not land is that "as wide as the hole" is the floor,
 *  not the target: smoke leaves a chimney at the mouth's width and then
 *  expands into the air for as long as you can see it. */
export const PUFF_R = [4, 6, 9, 13] as const;
/** The most puffs one flue keeps in the air, and the ceiling over all flues.
 *  A column needs its marks to read as a LINE — but at the sizes above they
 *  overlap into one, so the count comes DOWN as the marks go up: fewer, bigger,
 *  softer is a hearth plume; fourteen 27 px blobs is a smoke machine. The ink
 *  per column stays about level across both size changes, which is the point —
 *  he asked for bigger MARKS, not for more smoke. */
export const PER_VENT = 8;
export const MAX_PUFFS = 96;
/** One stoke cycle: a hearth fed and dying back. Long enough that the column
 *  is never seen to pulse, short enough to change while you stand there. */
export const STOKE_MS: [number, number] = [11_000, 26_000];
/** The rim's share of the core's value, baked into the texture (see header),
 *  and how much of the blob's radius the core occupies. A THIN rim on a 13 px
 *  mark is a hard outline; a proportional one keeps the two-tone reading as
 *  soft smoke at every size. */
export const RIM_MIX = 0.45;
export const CORE_FRAC = 0.62;

/** A round, whole-pixel blob of radius `r`, split into the pale core and the
 *  darker rim the two-tone trick needs (see the header). Generated rather than
 *  hand-listed because the sizes now go up to 13 px across, and a hand-listed
 *  13 px disc is a wall of coordinates nobody will ever check.
 *
 *  ROUND, NOT ISO-SQUASHED: this is smoke in the AIR. The ground shapes in
 *  this folder (`fish/` rings, `dawnmist/` patches) take the projection's
 *  14/32 squash because they lie ON the ground; a puff would read as a
 *  pancake if it did. */
export function blobPixels(r: number): { core: [number, number][]; rim: [number, number][] } {
  const core: [number, number][] = [];
  const rim: [number, number][] = [];
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d > r + 0.35) continue;
      (d > r * CORE_FRAC ? rim : core).push([x, y]);
    }
  return { core, rim };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** IS THIS A VENT WORTH SMOKING FROM? The scenery domain publishes HOW it
 *  found the hole, and that field exists because finding it took four rounds
 *  of the maintainer's own corrections (scenery/README.md). `opening` is a
 *  real measured hole and `flue_top` the mouth of a pot drawn light rather
 *  than dark; `silhouette` is the domain saying it found NEITHER and fell back
 *  to the outline — a plume there comes out of the brickwork. None ship today
 *  (117 opening, 3 flue_top over the 40 states x 3 facings), and that is
 *  exactly when to honour a confidence field: before it is ever wrong. */
export function vents(conf: string | null | undefined): boolean {
  return conf === "opening" || conf === "flue_top";
}

/** DOES THIS STACK SMOKE? A real hole AND a fire burning under it.
 *
 *  The second half is the whole rule: a chimney is masonry, not a smoke
 *  machine, and 6 of the_game's 8 stand over a hearth in a NOT_LIT state
 *  (maintainer 2026-09-14, standing in one of them: "the fire in the house is
 *  not burning (not a LIT state) and you still show smoke when I walk out").
 *  `hearth` is the seam's answer for the flame placement within half a cell of
 *  this vent — the effect never looks for the fire itself, because from the
 *  street the fire is not drawn at all.
 *
 *  A vent with NO fire under it does not smoke either: "nothing is burning"
 *  is the same answer whether the hearth is cold or absent. */
export function smokes(conf: string | null | undefined, hearth: boolean | undefined): boolean {
  return vents(conf) && hearth === true;
}

/** A stable value in [0,1) per placement — murmur3's finalizer. DETERMINISTIC
 *  ON PURPOSE: a chimney's stoke phase and period must be the same every time
 *  you walk past it, or the same stack breathes differently on each rebuild
 *  (the scenery list is rebuilt on every 96 px camera latch). */
export function hash01(n: number): number {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** This flue's own stoke cycle, from its placement index. */
export function stokePhase(place: number): number {
  return hash01(place * 2 + 1) * Math.PI * 2;
}
export function stokePeriod(place: number): number {
  return Math.round(STOKE_MS[0] + hash01(place * 2 + 2) * (STOKE_MS[1] - STOKE_MS[0]));
}

/** HOW HARD THE HEARTH IS BURNING, 0.44..1 — the fire fed and dying back. It
 *  never reaches 0: a hearth keeps embers, and a chimney that stops entirely
 *  is indistinguishable from a broken effect. Drives the emission rate and the
 *  puffs' opacity together, so a stoked fire is denser AND faster. */
export function stoke(ms: number, place: number): number {
  const p = stokePeriod(place);
  return 0.72 + 0.28 * Math.sin(stokePhase(place) + ((ms % p) / p) * Math.PI * 2);
}

/** How high a puff has climbed after `age` ms, in px above the mouth: fast out
 *  of the flue, slowing as it cools and mixes. The integral of a linearly
 *  decaying rise — the one curve this shares with the campfire, because it is
 *  the physics both obey and not a look. */
export function riseY(age: number, life: number, up: number): number {
  const t = clamp01(age / life);
  const s = Math.max(0, age) / 1000;
  return up * s * (1 - (1 - RISE_DRAG) * t * 0.5);
}

/** THE LEAN GROWS WITH HEIGHT. A puff still in the lee of the roof barely
 *  moves sideways; one well above it is in the moving air and is carried. The
 *  curl opens on the same ramp (a wisp at the mouth is tight), and the spread
 *  is superlinear so the column is a ribbon low down and a fan at the top. */
export function driftX(
  age: number,
  life: number,
  curl: number,
  phase: number,
  hz: number,
  spread: number,
): number {
  const t = clamp01(age / life);
  const s = Math.max(0, age) / 1000;
  const open = 0.35 + 0.65 * t;
  return WIND_X * s * open + Math.sin(phase + s * hz * Math.PI * 2) * curl * open + spread * Math.pow(t, 1.6);
}

/** ...and the small down-screen component of the same wind, on the same ramp.
 *  The rise always wins; this only tilts the column. */
export function driftY(age: number, life: number): number {
  const t = clamp01(age / life);
  return WIND_Y * (Math.max(0, age) / 1000) * (0.35 + 0.65 * t);
}

/** A puff's opacity: dense the moment it clears the flue (it has been
 *  accumulating in a pipe, unlike a wisp off an open flame), HOLDS for the
 *  first third while it is still a body of smoke, then thins away to nothing.
 *  Never switched off — the folder's standing rule. */
export function puffAlpha(age: number, life: number): number {
  if (age < 0 || age >= life) return 0;
  const t = age / life;
  const inn = Math.min(1, t / 0.07);
  if (t < 0.3) return inn;
  return inn * Math.pow((1 - t) / 0.7, 1.35);
}

/** How big the mark is, as an index into PUFF_R. MONOTONE: a plume expands
 *  and dies by thinning, so this never goes back down — the campfire's does,
 *  and that is the difference between smoke leaving a hole and smoke leaving a
 *  flame. */
export function puffSize(age: number, life: number): 1 | 2 | 3 | 4 {
  const t = clamp01(age / life);
  if (t < 0.06) return 1;
  if (t < 0.2) return 2;
  if (t < 0.5) return 3;
  return 4;
}

/** Ms until this flue lets go of the next puff, shortened by the stoke. */
export function nextGap(rnd: () => number, st: number): number {
  return (GAP_MS[0] + rnd() * (GAP_MS[1] - GAP_MS[0])) / Math.max(0.3, st);
}

/** THE GREY, AND IT IS PALE — the opposite of the campfire's, for the reason
 *  in the header: this mark carries its own dark rim, so its CORE is free to
 *  be the light half of the pair. Still graded by the sun, and firmly away
 *  from white at night: an ambient mark draws ABOVE the darkness overlay, so
 *  its own colour survives a night that has taken everything around it down —
 *  which is how the ants ended up white on night grass and were rejected for
 *  it (maintainer 2026-09-07). */
export function flueTint(sun: number): number {
  const v = Math.round(110 + 105 * clamp01(sun)); // 110 at night, 215 in full sun
  return (v << 16) | (v << 8) | v;
}

/** The feature's own likeliness, before the outdoor gain. A hearth burns
 *  HARDER when it is cold and wet and dark, and never goes out: banked at
 *  noon, roaring at night, stoked further by rain. */
export function weight(sun: number, rain: number): number {
  return clamp01(0.45 + 0.4 * (1 - clamp01(sun)) + 0.25 * clamp01(rain));
}

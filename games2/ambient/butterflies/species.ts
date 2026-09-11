/* WHAT COLOUR A BUTTERFLY IS — the maintainer's bands, 2026-09-11 (second
 * verdict, and it replaces the ten-mix table that came before it).
 *
 * "I hate that and don't want the butterflies to bring this much color into
 * the game. Can you make at least 50% of the butterflies whiteish and
 * blackish. 25% green-ish and red-ish and the rest 25% whatever you want. No
 * extreme/vibrant colors. This is a background effect."
 *
 * So two things are law here and both are tested:
 *
 *   THE BANDS. Pale and dark together are at least half of every butterfly
 *   drawn, green and red are a quarter between them, and the last quarter is
 *   mine. `BANDS` below is the contract and `server/test/butterflies.test.ts`
 *   asserts the shares add up — a colour added later cannot quietly shift the
 *   balance, which is the thing he actually objected to.
 *
 *   NOTHING VIBRANT. A background effect must not pull the eye, so every
 *   colour is capped at MAX_SAT saturation. The palette this replaces failed
 *   that badly and measurably: its orange sat at 0.81, its yellow 0.69, its
 *   blue 0.65, its green 0.63. Nothing here is over 0.45, and the test says
 *   so, because "muted" is a judgement that drifts and a number is not.
 *
 * His earlier "red and purple should have a higher weight 1.2x" survives as
 * SHAPE rather than a multiplier: the bands are now exact, so red takes the
 * larger half of the green/red band and a dusty mauve holds a place in my own
 * quarter. A 1.2x lift on top would break the shares he just gave.
 */

/* A MUTED PALETTE. Chalk and soot rather than white and black (pixel art has
 * no pure ends), and every hue pulled toward grey — these are meant to be
 * noticed as movement, not as colour. */
const CHALK = 0xe8e4da;
const CREAM = 0xdcd3bf;
const FAWN = 0xc0ab8e;
const OCHRE = 0xab9970;
const SAGE = 0x8a9c72;
const MOSS = 0x6b7a4e;
const BRICK = 0x94685c;
const RUST = 0x8f6a52;
const SLATE = 0x7c8a9c;
const MAUVE = 0x93789c;
const SOOT = 0x57534c;
const UMBER = 0x4a423a;
// markings: darker still, and never pure black
const CHARCOAL = 0x4f4b45;
const GREY = 0x7d7469;
const ASH = 0x3b3330;
const BARK = 0x6e5a45;
const DEEP = 0x40382c;
const SHADOW = 0x2b2926;
const NIGHT = 0x272320;
const STONE = 0x3a4049;
const IRIS = 0x443a48;
const PEAT = 0x46382c;
const LOAM = 0x574a37;
const OLIVE = 0x3f463a;

/** The most colour a background effect may carry (HSV saturation). */
export const MAX_SAT = 0.45;

/** His bands, and the share of every butterfly drawn that each one takes. */
export const BANDS = { pale: 28, dark: 22, green: 13, red: 12, free: 25 } as const;
export type Band = keyof typeof BANDS;

export interface Species {
  /** Stable name, used as the texture key and reported by `debug()`. */
  key: string;
  /** Which of his bands this belongs to. */
  band: Band;
  /** The ground colour — the one you would name the butterfly by. */
  bright: number;
  /** The darker colour it is marked with. */
  dark: number;
  /** How much of the butterfly is `dark`. */
  darkShare: number;
  /** Frequency, in percent. Relative, never normalised. */
  base: number;
}

/** PALE 28 + DARK 22 = his "at least 50% whiteish and blackish"; GREEN 13 +
 *  RED 12 = his 25%; FREE 25 = the quarter he left to me. */
export const SPECIES: readonly Species[] = [
  // whiteish
  { key: "chalk_charcoal", band: "pale", bright: CHALK, dark: CHARCOAL, darkShare: 0.3, base: 16 },
  { key: "cream_grey", band: "pale", bright: CREAM, dark: GREY, darkShare: 0.25, base: 12 },
  // blackish
  { key: "soot_shadow", band: "dark", bright: SOOT, dark: SHADOW, darkShare: 0.4, base: 12 },
  { key: "umber_night", band: "dark", bright: UMBER, dark: NIGHT, darkShare: 0.35, base: 10 },
  // greenish
  { key: "sage_olive", band: "green", bright: SAGE, dark: OLIVE, darkShare: 0.35, base: 8 },
  { key: "moss_deep", band: "green", bright: MOSS, dark: DEEP, darkShare: 0.45, base: 5 },
  // reddish — the larger half of the band, which is where his "red looks
  // cool" lives now that the shares are exact
  { key: "brick_ash", band: "red", bright: BRICK, dark: ASH, darkShare: 0.4, base: 7 },
  { key: "rust_peat", band: "red", bright: RUST, dark: PEAT, darkShare: 0.45, base: 5 },
  // my quarter: earth, one cool grey-blue, and a dusty mauve for the purple
  { key: "fawn_bark", band: "free", bright: FAWN, dark: BARK, darkShare: 0.3, base: 9 },
  { key: "ochre_loam", band: "free", bright: OCHRE, dark: LOAM, darkShare: 0.35, base: 6 },
  { key: "slate_stone", band: "free", bright: SLATE, dark: STONE, darkShare: 0.35, base: 6 },
  { key: "mauve_iris", band: "free", bright: MAUVE, dark: IRIS, darkShare: 0.4, base: 4 },
];

/** A species' drawing weight. */
export function weightOf(s: Species): number {
  return s.base;
}

const TOTAL = SPECIES.reduce((n, s) => n + weightOf(s), 0);

/** Pick a species for `r` in [0,1). Cumulative over the weights. */
export function pickSpecies(r: number): Species {
  let acc = Math.max(0, Math.min(1, r)) * TOTAL;
  for (const s of SPECIES) {
    acc -= weightOf(s);
    if (acc < 0) return s;
  }
  return SPECIES[SPECIES.length - 1];
}

/** HSV saturation of a packed RGB, 0..1 — how much COLOUR it carries. */
export function saturation(c: number): number {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  const b = c & 255;
  const hi = Math.max(r, g, b);
  return hi === 0 ? 0 : (hi - Math.min(r, g, b)) / hi;
}

/* HOW THE MIX BECOMES PIXELS — and why a split cannot be taken literally at
 * this size.
 *
 * A drawn butterfly is 13 painted pixels: ten wing and three body. A real
 * butterfly's dark half is its VEINS AND BORDERS, and at five pixels across
 * there are no veins to draw — spending 60% of the pixels on the marking gave
 * a dark blob with two bright specks, measured on screen.
 *
 * So the split sets HOW MUCH MARKING, not how much area: the dark colour takes
 * the body and up to MAX_DARK_PAIRS wing pairs, spent on the hindwing tips and
 * then the forewing tips, so the FOREWING MASS — the part that tells you what
 * colour the butterfly is — always survives. Pairs, always left and right
 * together: asymmetric markings at this size read as damage. */
export const WING_PAIRS = 5;
/** The most wing pairs the marking may take. */
export const MAX_DARK_PAIRS = 3;
export const PAINTED_PX = 13;
export const BODY_PX = 3;

/** How many wing PAIRS take the dark colour, for a dark share of `share`. */
export function darkPairs(share: number): number {
  const px = PAINTED_PX * share - BODY_PX; // the body is already dark
  return Math.max(0, Math.min(MAX_DARK_PAIRS, Math.round(px / 2)));
}

/** The dark share a species is actually DRAWN with, once rounded to pixels. */
export function drawnDarkShare(s: Species): number {
  return (BODY_PX + 2 * darkPairs(s.darkShare)) / PAINTED_PX;
}

/* THE BODY IS DARK BUT NOT A DIFFERENT CREATURE. Painting it the mix's flat
 * dark colour split a brown butterfly into two blobs with a bar between them —
 * the same failure a near-black body had over grass, and for the same reason:
 * the one pixel column joining the wings was the one that did not belong to
 * them. Blending it a third of the way back toward the wing colour keeps it
 * the darkest part of the creature while keeping the creature one creature. */
const BODY_TOWARD_WING = 0.35;

export function bodyColour(s: Species): number {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * BODY_TOWARD_WING) & 255;
  const d = [(s.dark >> 16) & 255, (s.dark >> 8) & 255, s.dark & 255];
  const w = [(s.bright >> 16) & 255, (s.bright >> 8) & 255, s.bright & 255];
  return (mix(d[0], w[0]) << 16) | (mix(d[1], w[1]) << 8) | mix(d[2], w[2]);
}

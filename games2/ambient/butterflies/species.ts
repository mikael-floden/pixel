/* WHAT COLOUR A BUTTERFLY IS — the maintainer's table, 2026-09-11.
 *
 * The first cut gave each butterfly ONE flat colour from a palette I chose,
 * and his verdict was short: "I like the effect/animation but not the colour.
 * You made them blue and yellow." Real butterflies are not one colour. They
 * are a MIX — a bright ground with a dark border, or a dark ground with a
 * bright flash — and he sent the ten mixes he wants with how common each one
 * should be. That table IS this file; the percentages are his, not derived.
 *
 * RED AND PURPLE CARRY A 1.2x LIFT, also his: "red and purple should have a
 * higher weight 1.2x because that looks cool." They stay the two rarest, so
 * meeting one is still an event — the lift makes it happen a fifth more
 * often, which is the whole point of a rare colour you are pleased to see.
 *
 * The `dark` share is the second column of his table read as "how much of the
 * butterfly is the darker colour". `darkPairs` turns it into whole pixels,
 * because at five pixels across there is no such thing as 45% of a wing.
 */

/* A pixel-art palette: nothing is pure black or pure white, and the green sits
 * off the grass it flies over so a green butterfly still has a silhouette.
 *
 * GREEN AND BLUE ARE SET APART ON PURPOSE. They are the two halves of his
 * rarest mix (green+blue, 1%), and the first pair I picked were 13 luma apart
 * — at four pixels tall that is not two colours, it is one mushy one. The
 * green went up and the blue went down until they are 46 apart; blue still
 * clears its own black by 70, so blue+black lost nothing. */
const BROWN = 0x8a5a34;
const BLACK = 0x2b2724;
const ORANGE = 0xe07a2a;
const GREEN = 0x7abd46;
const YELLOW = 0xf2d24b;
const BLUE = 0x4472c4;
const WHITE = 0xf1ece0;
const RED = 0xc9392b;
const PURPLE = 0x9350c4;

/** His lift for the two colours he likes best. */
export const RARE_LIFT = 1.2;

export interface Species {
  /** Stable name, used as the texture key and reported by `debug()`. */
  key: string;
  /** The ground colour — the one you would name the butterfly by. */
  bright: number;
  /** The darker colour it is marked with. */
  dark: number;
  /** How much of the butterfly is `dark`, from his table. */
  darkShare: number;
  /** His frequency, in percent. Relative, never normalised. */
  base: number;
  /** Whether his 1.2x lift applies (red and purple). */
  lifted?: boolean;
}

/** HIS TABLE, in his order — commonest first. */
export const SPECIES: readonly Species[] = [
  { key: "brown_black", bright: BROWN, dark: BLACK, darkShare: 0.3, base: 22 },
  { key: "black_orange", bright: ORANGE, dark: BLACK, darkShare: 0.6, base: 18 },
  { key: "brown_orange", bright: ORANGE, dark: BROWN, darkShare: 0.65, base: 15 },
  { key: "green_black", bright: GREEN, dark: BLACK, darkShare: 0.3, base: 12 },
  { key: "yellow_black", bright: YELLOW, dark: BLACK, darkShare: 0.4, base: 11 },
  { key: "blue_black", bright: BLUE, dark: BLACK, darkShare: 0.45, base: 8 },
  { key: "white_black", bright: WHITE, dark: BLACK, darkShare: 0.25, base: 7 },
  { key: "red_black", bright: RED, dark: BLACK, darkShare: 0.5, base: 4, lifted: true },
  { key: "purple_black", bright: PURPLE, dark: BLACK, darkShare: 0.4, base: 2, lifted: true },
  { key: "green_blue", bright: GREEN, dark: BLUE, darkShare: 0.5, base: 1 },
];

/** A species' drawing weight: his percentage, with his lift where it applies. */
export function weightOf(s: Species): number {
  return s.base * (s.lifted ? RARE_LIFT : 1);
}

const TOTAL = SPECIES.reduce((n, s) => n + weightOf(s), 0);

/** Pick a species for `r` in [0,1). Cumulative over the lifted weights. */
export function pickSpecies(r: number): Species {
  let acc = Math.max(0, Math.min(1, r)) * TOTAL;
  for (const s of SPECIES) {
    acc -= weightOf(s);
    if (acc < 0) return s;
  }
  return SPECIES[SPECIES.length - 1];
}

/* HOW THE MIX BECOMES PIXELS — and why the percentages cannot be taken
 * literally at this size.
 *
 * A drawn butterfly is 13 painted pixels: ten wing and three body. His column
 * of splits ("60% black / 40% orange") counts the VEINS AND BORDERS of a real
 * butterfly, and at five pixels across there are no veins to draw — spending
 * 60% of the pixels on black gives a black blob with two orange specks, which
 * is not a monarch, it is a fly. Measured on screen: the first cut did exactly
 * that and black+orange came out unreadable.
 *
 * So the split sets HOW MUCH MARKING, not how much area: the dark colour takes
 * the body and up to MAX_DARK_PAIRS wing pairs, spent on the hindwing tips and
 * then the forewing tips, so the FOREWING MASS — the part that tells you what
 * colour the butterfly is — always survives. His order is preserved exactly
 * (a mix he called darker is never drawn lighter); his absolute percentages
 * are not, and that is deliberate.
 *
 * Pairs, always left and right together: asymmetric markings at this size read
 * as damage rather than pattern.
 */
export const WING_PAIRS = 5;
/** The most wing pairs the marking may take — the rest of the wing is the
 *  butterfly's own colour, or it has no colour. */
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
 * dark colour split a brown butterfly into two brown blobs with a black bar
 * between them — the same failure the very first cut had with a near-black
 * body, and for the same reason: the one pixel column joining the wings was
 * the one that did not belong to them. Blending it a third of the way back
 * toward the wing colour keeps it the darkest part of the creature while
 * keeping the creature one creature. */
const BODY_TOWARD_WING = 0.35;

export function bodyColour(s: Species): number {
  const mix = (a: number, b: number) => Math.round(a + (b - a) * BODY_TOWARD_WING) & 255;
  const d = [(s.dark >> 16) & 255, (s.dark >> 8) & 255, s.dark & 255];
  const w = [(s.bright >> 16) & 255, (s.bright >> 8) & 255, s.bright & 255];
  return (mix(d[0], w[0]) << 16) | (mix(d[1], w[1]) << 8) | mix(d[2], w[2]);
}

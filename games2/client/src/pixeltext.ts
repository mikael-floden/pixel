/**
 * A 5x7 pixel font, painted into a canvas.
 *
 * WHY THIS EXISTS: the maintainer's logo (`public/logo.webp`, generated with
 * Gemini) carried its tagline BAKED INTO THE ART — "A THOUSAND PATHS. ONE
 * LIFE." — and every regeneration of that art costs quality, so the words
 * could never be changed without redrawing the whole logo. The letters are
 * gone from the art now and the line is drawn here instead, over the banner
 * the art still provides (select.ts).
 *
 * THE GLYPHS ARE THE LOGO'S OWN. They were read straight off the artwork
 * before it was edited: the baked tagline is a 5x7 font at 2 art-px per cell
 * (cap height 14 art-px, advance 6 cells), and the shapes below are the ones
 * the art draws — a chunky, flat-terminal, all-caps face. A/T/H/O/U/S/N/D/P/
 * E/L/I/F and the full stop were transcribed pixel for pixel; the rest are
 * drawn to the same skeleton so any sentence stays in the same voice.
 *
 * IT IS A CANVAS, NOT A WEB FONT, for three reasons: the page ships no font
 * files (a woff2 would be a new blocking request in front of the title
 * screen), no installed font is a 5x7 pixel face, and this way the letters
 * downscale EXACTLY like the logo art beside them — same grid, same
 * softening — instead of hinting themselves into a different look at the
 * ~4px cap height the logo renders at on a phone.
 *
 * SMOOTH, NOT `pixelated`: this is the one place the project's
 * nearest-neighbour rule does not apply, and deliberately. The line is drawn
 * at the art's own 2px-per-cell grid and then scaled DOWN by the same factor
 * the logo is (~0.28 on a phone) — a downscale bake, which the rule allows.
 * Forcing nearest here would drop every other row of a 7-row cap and the
 * words would come apart.
 */

/** Cell columns per glyph row, MSB-first, one string per row. */
type Glyph = string[];

const W = 5; // the normal glyph box, in cells
export const FONT_ROWS = 7; // cap height, in cells
export const FONT_GAP = 1; // cells between glyphs
/**
 * Cells a word space adds beyond a normal advance. The artwork's own value is
 * 3 (its word advances measure 17-18 art-px against a 12px normal one); this
 * is 2 because the maintainer needed a long line to fit and the difference is
 * ONE art pixel per word gap — 0.3 css px on a phone, invisible, and it buys
 * 4-6 cells on every line.
 */
export const FONT_SPACE = 2;

// prettier-ignore
const FONT: Record<string, Glyph> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#", "#", "#", "#", "#", "#", "#"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  // S is the art's own: a FULL-width top bar and a middle that runs to the
  // right edge (transcribed off the logo, not the usual .####/.###. form).
  S: ["#####", "#....", "#....", ".####", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#...#", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "#...#", ".###."],
  ".": [".", ".", ".", ".", ".", ".", "#"],
  ",": [".", ".", ".", ".", ".", "#", "#"],
  "'": ["#", "#", ".", ".", ".", ".", "."],
  "!": ["#", "#", "#", "#", "#", ".", "#"],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  ":": [".", ".", "#", ".", ".", "#", "."],
  ";": [".", ".", "#", ".", ".", "#", "#"],
  "-": ["...", "...", "...", "###", "...", "...", "..."],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
};

const glyph = (ch: string): Glyph | null => FONT[ch] ?? null;
const glyphCells = (g: Glyph) => g[0].length;

/** Width of `text` in CELLS (no trailing gap). 0 for an empty line. */
export function measurePixelText(text: string): number {
  let w = 0;
  let pending = false; // a gap is owed before the next glyph
  for (const ch of text.toUpperCase()) {
    if (ch === " ") {
      // A word space is the normal gap PLUS FONT_SPACE, and it replaces the
      // owed gap rather than stacking on it.
      w += (pending ? FONT_GAP : 0) + FONT_SPACE;
      pending = false;
      continue;
    }
    const g = glyph(ch);
    if (!g) continue;
    if (pending) w += FONT_GAP;
    w += glyphCells(g);
    pending = true;
  }
  return w;
}

/**
 * The tagline ink, MEASURED off the logo before the letters were removed —
 * ONE COLOUR PER CELL ROW, top of the cap to the baseline. It is deliberately
 * not a flat fill and not a straight ramp either: the art holds a warm gold
 * almost all the way down and only dips on the last row, which a linear
 * top-to-bottom gradient smears into something duller through the middle.
 * These are core-pixel means (the paint itself, never its antialiasing), so
 * the soft upscale below is what produces every tone between them.
 *
 * The maintainer's note when a flat cream was tried: "your version is a
 * little whiter and not as gold" — this table is the answer to that.
 */
export const TAGLINE_INK: string[] = [
  "#f6e6c2", "#f3e3bd", "#f7e4bc", "#f2ddb1", "#f2ddae", "#f5e1b0", "#e0ca99",
];

/**
 * The ring the art bleeds onto the plate around every stroke — measured the
 * same way, from the pixels just OUTSIDE the ink. Warm brown, not grey: this
 * is what stops the letters reading as pasted-on white.
 */
export const TAGLINE_SHOULDER = "#5a4b36";

export interface PixelTextOpts {
  /** device pixels per font cell (the logo art itself uses 2) */
  scale?: number;
  /** one colour, or one per cell row (FONT_ROWS entries) down the cap */
  color?: string | string[];
  /**
   * Draw the art's warm SHOULDER around every stroke (default). Measured on
   * the baked tagline, a letter is three tones, not one: a bright core, a
   * dimmer rim where the paint meets its own edge, and a ring of warm brown
   * bleeding onto the plate. A bilinear blur was tried first and is wrong in
   * a way that is easy to miss — it covered MORE pixels than the art while
   * carrying 20% LESS light, i.e. wide and washed out where the art is tight
   * and bright ("you need to work on the bold and texture", maintainer). A
   * hard 1px dilation in SHOULDER under a crisp core reproduces all three
   * tones and the weight. Pass false for bare glyphs with no shoulder.
   */
  soft?: boolean;
}

/**
 * Paint `text` into a fresh canvas sized exactly to the ink box. The caller
 * owns the CSS size, which is what decides how far it is scaled down.
 */
export function drawPixelText(text: string, opts: PixelTextOpts = {}): HTMLCanvasElement {
  const scale = Math.max(1, Math.round(opts.scale ?? 2));
  const cells = measurePixelText(text);
  const soft = opts.soft !== false;
  const pad = soft ? 1 : 0; // room for the shoulder ring
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, cells * scale + pad * 2);
  cv.height = FONT_ROWS * scale + pad * 2;
  const g = cv.getContext("2d");
  if (!g) return cv;
  g.imageSmoothingEnabled = false;
  const ink = opts.color ?? TAGLINE_INK;
  const rowInk = (r: number) => (typeof ink === "string" ? ink : ink[r % ink.length]);

  /** Walk the laid-out cells once per pass. */
  const eachCell = (fn: (col: number, row: number) => void) => {
    let x = 0;
    let pending = false;
    for (const ch of text.toUpperCase()) {
      if (ch === " ") {
        x += (pending ? FONT_GAP : 0) + FONT_SPACE;
        pending = false;
        continue;
      }
      const gl = glyph(ch);
      if (!gl) continue;
      if (pending) x += FONT_GAP;
      for (let r = 0; r < FONT_ROWS; r++) {
        const row = gl[r];
        for (let c = 0; c < row.length; c++) if (row[c] === "#") fn(x + c, r);
      }
      x += glyphCells(gl);
      pending = true;
    }
  };

  if (soft) {
    // Pass 1 — the shoulder: every cell grown 1px in each direction. Where
    // neighbouring cells overlap the ring simply merges, which is what makes
    // it a true dilation of the whole word rather than a box per letter.
    g.fillStyle = TAGLINE_SHOULDER;
    eachCell((c, r) => g.fillRect(c * scale, r * scale, scale + 2, scale + 2));
  }
  // Pass 2 — the core, one measured tone per cell row.
  eachCell((c, r) => {
    g.fillStyle = rowInk(r);
    g.fillRect(c * scale + pad, r * scale + pad, scale, scale);
  });
  return cv;
}

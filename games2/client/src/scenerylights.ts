/** SCENERY LIGHTS — a `lit` placement is a LIGHT, derived from its own art.
 *
 * The scenery domain publishes no light parameters (`lights: null`, prose
 * glow concepts only), and maps2 placed 162 lit pieces expecting the night to
 * light up (maintainer, 2026-09-06: "the LIT scenery is not lit at all"). So
 * the game derives each light from the pixels: the ones that DIFFER between
 * the LIT frame and its NOT_LIT sibling are the emissive ones (a flame, a
 * crystal's glow); without a sibling, the bright saturated ones. Their
 * centroid is where the light sits (a lamp's head, not its base), their mean
 * colour is the light's colour, their area sets the radius. Pure functions —
 * the scene feeds pixels and reads back params; `server/test/scenerylights.test.ts`.
 */
export interface PixelBuf {
  w: number;
  h: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface Emissive {
  /** Centroid of the emissive pixels, canvas px. */
  cx: number;
  cy: number;
  /** Emissive pixel count. */
  area: number;
  /** Mean colour of the emissive pixels, 0..1, peak-normalised to 1. */
  color: [number, number, number];
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The emissive pixels of a LIT frame. With the NOT_LIT sibling (same canvas
 *  size — PixelLab relights the same object) a pixel is emissive when it got
 *  materially brighter AND changed colour; alone, when it is bright and
 *  saturated or near-white. Null when fewer than 4 pixels qualify. */
export function deriveEmissive(lit: PixelBuf, unlit?: PixelBuf | null): Emissive | null {
  const { w, h, data } = lit;
  const useDiff = !!unlit && unlit.w === w && unlit.h === h;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 128) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const L = luma(r, g, b);
      let on = false;
      if (useDiff) {
        const u = unlit!.data;
        const dr = Math.abs(r - u[i]);
        const dg = Math.abs(g - u[i + 1]);
        const db = Math.abs(b - u[i + 2]);
        const Lu = luma(u[i], u[i + 1], u[i + 2]);
        on = dr + dg + db > 60 && L > Lu + 20 && L > 90;
      } else {
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        on = (L > 160 && sat > 40) || L > 230;
      }
      if (!on) continue;
      n++;
      sx += x;
      sy += y;
      sr += r;
      sg += g;
      sb += b;
    }
  }
  if (n < 4) return null;
  const mr = sr / n / 255;
  const mg = sg / n / 255;
  const mb = sb / n / 255;
  const peak = Math.max(mr, mg, mb, 0.001);
  return { cx: sx / n, cy: sy / n, area: n, color: [mr / peak, mg / peak, mb / peak] };
}

export type LightKind = "flame" | "glow";

/** The spawn campfire's peak channel ([1.9, 0.88, 0.3]): strength 1.0 in the
 *  manifest is the campfire — nothing outshines it (maps2 ask, 2026-09-06). */
export const CAMPFIRE_PEAK = 1.9;

/** Params from THE PUBLISHED BLOCK (the manifest wins over the pixels): radius
 *  as given — NO CAP (maintainer 2026-09-07: the campfire is one light, not
 *  the game's maximum) — colour as given, intensity = strength ×
 *  the campfire's peak. Flicker is deferred by the maintainer (a type will be
 *  added beside strength later) — steady. Shadows still by kind. */
export function lightFromBlock(
  b: { strength: number; color: [number, number, number]; radius: number },
  kind: LightKind,
): SceneryLightParams | null {
  if (b.strength <= 0) return null; // strength 0 is no light
  const peak = Math.max(b.color[0], b.color[1], b.color[2], 0.001);
  const inten = CAMPFIRE_PEAK * b.strength;
  return {
    radius: Math.max(0.5, b.radius),
    color: [(b.color[0] / peak) * inten, (b.color[1] / peak) * inten, (b.color[2] / peak) * inten],
    flicker: 0,
    anim: 1,
    shadows: kind === "flame",
  };
}

/** Flame-like pieces (lamps, torches, braziers, fires) flicker and cast
 *  shadows; the rest (crystals, mushrooms, runes) pulse softly, shadow-free. */
export function lightKindOf(pieceId: string): LightKind {
  return /light|lamp|lantern|torch|brazier|fire|candle|beacon|hearth|forge/i.test(pieceId) ? "flame" : "glow";
}

export interface SceneryLightParams {
  radius: number; // cells
  color: [number, number, number]; // may exceed 1 (overbright plateau, the campfire trick)
  flicker: number;
  anim: 1 | 2; // 1 pulse, 2 flicker — the glow stamp's waveform
  shadows: boolean;
}

/** Campfire-anchored defaults (spec/LIGHT_BUDGET.md): radius from the
 *  emissive area, capped at 4.5 (a fallback default, not a table); a streetlight's flame
 *  (~40 px) lands near 2.8 cells, a big crystal at the 4.5 cap. */
export function lightParams(e: Emissive, kind: LightKind): SceneryLightParams {
  const radius = Math.min(4.5, Math.max(2, 2 + Math.sqrt(e.area) / 8));
  const inten = kind === "flame" ? 1.8 : 1.5;
  return {
    radius,
    color: [e.color[0] * inten, e.color[1] * inten, e.color[2] * inten],
    flicker: kind === "flame" ? 0.5 : 0.15,
    anim: kind === "flame" ? 2 : 1,
    shadows: kind === "flame",
  };
}

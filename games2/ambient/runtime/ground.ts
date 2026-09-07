import type Phaser from "phaser";

// Shared placement for the GROUND-LEVEL critters (ants, spiders). They are far
// too small for the sprite-art treatment the flocks get — a bird is a 34px
// 8-direction PixelLab object, an ant is one pixel — so there is no art
// pipeline here at all: a couple of hand-set pixels, and BEHAVIOUR does the
// work of telling you what you are looking at. What they do need in common is
// somewhere believable to stand.

/** Is the point drawn at (wx, wy) dry, walkable, TOP ground? The game's own
 * probe, face-aware: it says no on water, on a cliff FACE, and on anything a
 * body could not stand on. Fenced like every probe read — no probe means no
 * ground, so the critters simply stay away rather than crawling on the sky. */
export function landableAt(wx: number, wy: number): boolean {
  const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
  const f = ml?.landableAtScreen as undefined | ((x: number, y: number) => boolean);
  if (!f) return false;
  try {
    return !!f(wx, wy);
  } catch {
    return false;
  }
}

/**
 * A random spot in `view` that is dry ground with `margin` px of dry ground on
 * all four sides, or null after `tries`.
 *
 * The margin is what keeps a critter off SHORELINES AND CLIFF LIPS. The probe
 * resolves the front-most drawn surface, so a point one pixel inside a cliff
 * edge answers "landable" while the pixels around it are a vertical face — a
 * bug placed there reads as clinging to a wall. The flocks learned the same
 * lesson (the ambient water marks call it the hillside bug); this is the
 * ground version of it.
 */
export function findGround(
  view: { x: number; y: number; width: number; height: number },
  rnd: () => number,
  margin: number,
  tries = 10,
): { x: number; y: number } | null {
  for (let t = 0; t < tries; t++) {
    const x = Math.round(view.x + rnd() * view.width);
    const y = Math.round(view.y + rnd() * view.height);
    if (
      landableAt(x, y) &&
      landableAt(x + margin, y) &&
      landableAt(x - margin, y) &&
      landableAt(x, y + margin) &&
      landableAt(x, y - margin)
    )
      return { x, y };
  }
  return null;
}

/** Paint a handful of whole pixels into a texture. The critters are drawn at
 * scale 1 on integer positions, so one art pixel IS one world pixel and they
 * share the grid the characters and terrain are drawn on. */
export function paintPixels(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  colour: number,
  px: [number, number][],
): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(colour, 1);
  for (const [x, y] of px) g.fillRect(x, y, 1, 1);
  g.generateTexture(key, w, h);
  g.destroy();
}

/* CONTRAST, NOT COLOUR — how a 1-3 px crawler stays VISIBLE.
 *
 * These are the smallest things this agent draws and they sit UNDER the
 * darkness overlay, graded by the light where they stand (which is right: they
 * are matter on the ground, not UI). But a near-black dot on ground the night
 * has taken down to luma 33-55 differs from it by ONE TO SIX luma — measured on
 * the real screen, day and night, at four spots: +6.2, -0.3, -2.2, +0.7. That
 * is invisible, and it is why the maintainer could "only see ants and spiders
 * near the spawn (the houses near the bonfire)" — the bonfire is the only
 * thing lighting the ground enough for a dark speck to read against it.
 *
 * So the tint follows the LIGHT, not the animal: dark on lit ground, pale on
 * dark ground, crossing over as the sun goes. THE ART IS PAINTED WHITE for
 * this: Phaser's setTint MULTIPLIES, so tinting a near-black texture pale can
 * only make it darker — the first cut did exactly that and measured a night
 * spider at 11.6 luma of contrast while claiming to have paled it. White art
 * plus a tint IS the drawn colour. The creature is the same colour
 * it always was where there is light to see it by; after dark it reads as a
 * silhouette the way a moth or a spider does against a night floor. Footsteps
 * settled this same argument the same way (games2/CLAUDE.md: tints chosen "for
 * CONTRAST, not match"). */
export function crawlerTint(dark: number, env: { sun: number; night: number }): number {
  const pale = 0xb9c4d6; // moonlit grey-blue: a silhouette, never a light source
  const t = Math.max(0, Math.min(1, env.night - env.sun * 0.5));
  const mix = (a: number, b: number, k: number) => Math.round(a + (b - a) * k) & 255;
  const d = [(dark >> 16) & 255, (dark >> 8) & 255, dark & 255];
  const p = [(pale >> 16) & 255, (pale >> 8) & 255, pale & 255];
  return (mix(d[0], p[0], t) << 16) | (mix(d[1], p[1], t) << 8) | mix(d[2], p[2], t);
}

/* THE LEVEL UNDER A DRAWN POINT — what makes "flat" answerable.
 *
 * `landableAt` asks whether the surface drawn at a screen point can be stood
 * on, and a CLIFF answers yes twice: the plateau top and the ground at its
 * foot are drawn at different screen points, both walkable, and a straight
 * screen-space line from one to the other passes every walkability check while
 * crossing a wall in the world. That is an ant trail walking down a cliff face
 * (maintainer 2026-09-07, with the screenshot: "I don't want ants to walk down
 * from uphill to downhill like this. You must make sure the ground is flat").
 *
 * There is no way to see that in screen space alone — the projection subtracts
 * level x storey height from y, so a point 6 levels up and 6 storeys down the
 * screen is the SAME pixel. The game's own picker resolves it (`__ml.pickAt`
 * returns the world cell AND its level), so ask that: same level everywhere =
 * flat ground, whatever it looks like on screen.
 */
export function levelAt(wx: number, wy: number): number | null {
  const ml = (window as unknown as { __ml?: Record<string, (...a: never[]) => unknown> }).__ml;
  const f = ml?.pickAt as undefined | ((x: number, y: number) => { x: number; y: number; lvl: number } | null);
  if (!f) return null; // no probe: every level reads the same, i.e. no constraint
  try {
    const p = f(wx, wy);
    return p ? p.lvl : null;
  } catch {
    return null;
  }
}

/** Is the drawn point walkable AND on the same terrace as `lvl`? A null `lvl`
 * (or no picker) means "level unknown", which must not block placement — the
 * feature degrades to the walkability test it had before. */
export function flatWith(lvl: number | null, wx: number, wy: number): boolean {
  if (!landableAt(wx, wy)) return false;
  if (lvl === null) return true;
  const here = levelAt(wx, wy);
  return here === null || here === lvl;
}

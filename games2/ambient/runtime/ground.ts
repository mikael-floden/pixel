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

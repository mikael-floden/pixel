// THE TREE OVER THE HOUSE (maintainer 2026-09-12, with the screenshot at the
// spawn: "Can you fade out the scenery if it covers too much space inside the
// house? I feel the tree at the spawn almost cover the entire house... I still
// want to see this effect on trees and other scenery that doesn't cover 50% of
// the house like this tree.")
//
// Inside a room the outside is DRAWN AT ZERO AMBIENT (INDOOR.md), so a tree in
// front of the house reads as a black silhouette over the lit floor — the
// effect he keeps for a bush at the door. A canopy that buries half the room is
// the room gone. THE MEASURE is the share of the room's floor cells whose top
// centre lies under the piece's drawn box: a piece's box is its art's whole
// crop (trunk and canopy), the room is the cut-away's own `roof` set, and both
// are what the eye sees on screen, so "half the house" is half the floor. At or
// past SCENERY_COVER_FADE the piece fades OUT with the indoor grade — the curve
// the room's own light darkens on, so it dissolves as the roof does — and comes
// back on the way out. Under the line nothing changes.
//
// Pure: the scene projects the room's cells and hands the points over, so this
// is testable on the tick (server/test/scenerycover.test.ts).

/** A piece over this share of the room's floor cells fades out. His line:
 *  "scenery that doesn't cover 50% of the house" keeps the silhouette. */
export const SCENERY_COVER_FADE = 0.5;

export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScreenPt {
  x: number;
  y: number;
}

/** The share (0..1) of `cells` — the room's floor cells' top centres on
 *  screen — that lie inside `box`, a piece's drawn box on the same screen. */
export function roomCoverFraction(box: ScreenBox, cells: readonly ScreenPt[]): number {
  if (!cells.length || box.w <= 0 || box.h <= 0) return 0;
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  let n = 0;
  for (const c of cells) if (c.x >= box.x && c.x < x1 && c.y >= box.y && c.y < y1) n++;
  return n / cells.length;
}

/** Does a piece with this cover share fade out while the room is entered? */
export function coversRoom(cover: number): boolean {
  return cover >= SCENERY_COVER_FADE;
}

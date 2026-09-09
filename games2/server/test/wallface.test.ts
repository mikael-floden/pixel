/** THE OCCLUDER'S FACE BAND DRAWS EACH STOREY'S OWN TILE.
 *
 * The occluder pass duplicates a wall column as SPRITES over the ground
 * texture, and it used to stack ONE key — the column's representative course —
 * from the lowest exposed face to the cap. The resolver varied the tile per
 * storey and the ground texture was painted correctly from `wall.stack`, so
 * every probe that read the resolver or hashed the render texture reported
 * variety; the sprites covered it. What the maintainer saw was a single tile
 * repeated the whole height of every mountain (2026-09-08, with the
 * photograph: "code that used the same tile the entire vertical strip").
 *
 * This test is deliberately synthetic and fixture-free: the world fixtures are
 * sparse-checked-out of CI, and a gate that skips is not a gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { faceKey, faceKeyAt } from "../../client/src/tiles3runtime";
import { artKey } from "../../client/src/tiles3draw";
import type { Tiles3Cell, TileArt } from "../../client/src/tiles3";

const art = (path: string): TileArt =>
  ({ role: "storey", ground: "grey_stone", key: path, path, w: 64, h: 64 }) as TileArt;

/** A four-storey wall whose courses are three DIFFERENT tiles, plus a cap. */
const cellOf = (paths: string[], first = 0): Tiles3Cell =>
  ({
    kind: "wall",
    level: first + paths.length - 1,
    wall: {
      side: "grey_stone",
      mid: art(paths[0]),
      midGround: "grey_stone",
      stack: paths.map((p, i) => ({ storey: first + i, tile: art(p), y: 0 })),
    },
  }) as unknown as Tiles3Cell;

const tex = (resident: string[]) => ({
  exists: (k: string) => resident.includes(k),
  get: () => undefined,
  addCanvas: () => null,
  remove: () => {},
});

const PATHS = ["a.webp", "b.webp", "c.webp", "b.webp", "d.webp"];
const ALL = PATHS.map(artKey);

test("the face band draws each storey's OWN tile, not one key for the column", () => {
  const cell = cellOf(PATHS);
  const t = tex(ALL);
  const got = PATHS.map((_, lvl) => faceKeyAt(t, cell, lvl));
  assert.deepEqual(got, PATHS.map(artKey), "a storey drew a tile that is not its own");
  // Non-vacuous: the fixture really does carry more than one tile, and the old
  // one-key behaviour really is different from the new answer.
  assert.ok(new Set(PATHS).size > 1, "fixture is vacuous — every storey is the same tile");
  const oneKey = faceKey(t, cell);
  assert.ok(
    got.some((k) => k !== oneKey),
    "the per-storey answer never differs from the column's one key — the bug would pass",
  );
});

test("a stack that does not start at storey 0 still indexes correctly", () => {
  // `from` is the lowest EXPOSED face, so a wall standing on higher ground has
  // a stack whose first entry is not storey 0. Indexing off zero would read the
  // wrong course, or off the end.
  const cell = cellOf(PATHS, 6);
  const t = tex(ALL);
  for (let i = 0; i < PATHS.length; i++)
    assert.equal(faceKeyAt(t, cell, 6 + i), artKey(PATHS[i]), `storey ${6 + i} drew the wrong course`);
  // Off both ends: fall back to the representative course, never undefined and
  // never a crash — a hole in the band is a body drawn through a mountain.
  assert.equal(faceKeyAt(t, cell, 5), faceKey(t, cell));
  assert.equal(faceKeyAt(t, cell, 99), faceKey(t, cell));
});

test("a storey whose art has not landed falls back, and a column with none reports null", () => {
  const cell = cellOf(PATHS);
  // "c" is still streaming: that storey takes the representative course.
  const partial = tex(ALL.filter((k) => k !== artKey("c.webp")));
  assert.equal(faceKeyAt(partial, cell, 2), artKey("a.webp"), "a streaming storey must fall back");
  assert.equal(faceKeyAt(partial, cell, 1), artKey("b.webp"), "a resident storey must NOT fall back");
  // Nothing resident at all: null, so the caller skips the column rather than
  // drawing a missing texture.
  assert.equal(faceKeyAt(tex([]), cell, 1), null);
  assert.equal(faceKeyAt(tex(ALL), { kind: "field" } as unknown as Tiles3Cell, 0), null);
});

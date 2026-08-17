# The vertical pitch, and why the game currently draws tiles wrong

The maintainer saw a small jump in the back edge of a tile in the wiki and asked the
right question: *we have never investigated this — maybe we have been doing it wrong
the whole time.* We had, and it is not only in the renders.

## What was measured

Paint a tile's top surface magenta and its two wall faces cyan, assemble a 6x6 FLAT
field at a given vertical pitch, then count **interior wall**: a wall pixel that still
has top surface below it in the same column. In a lattice that closes, that is
geometrically impossible — every tile's wall is covered by the tile in front.

## The result

Tiles 3.0, whose top diamond is 64x28 (half-height 14):

| DY | interior wall | top hidden under neighbours |
|----|--------------:|----------------------------:|
| 12 | 0             | 4780 |
| 13 | 0             | 2880 |
| **14** | **0**     | **960**  <- closes, least overlap |
| 15 | **960**       | 0 |
| 16 | 2880          | 0 |
| 17 | 4800          | 0 |

tiles2, whose diamond is half-height 13, closes at 13 and leaks 570 px at 15.

Two things fall out, and only the first was obvious beforehand:

* interior wall is exactly ZERO at every pitch at or below the half-height, and appears
  the moment the pitch exceeds it, growing by a constant per step — one band per tile
  boundary, not an accumulating error.
* a pitch BELOW the half-height also closes. It simply hides more of each tile under its
  neighbour. So the half-height is not the only correct pitch, it is the largest one
  that closes, which makes it the efficient one.

## The consequence

`games2/shared/src/index.ts` sets `ISO_DY = 15`, and the wiki draws with the game's
projection. 15 exceeds BOTH generations' half-heights, so the shipping game has been
drawing tiles with a band of wall showing between them — tiles2 by 2 px, tiles 3.0 by 1.
That band is the faint grid visible across a flat field, and the irregular step in a
plateau's back edge.

## What is NOT established

* Measured on ONE tile per generation. Before any constant moves this wants running
  across all 56 cells and a proper sample of tiles2.
* Whether `ISO_DY = 15` was chosen deliberately. It is the game agent's constant and
  characters, monsters and scenery are projected with the same numbers, so changing it
  moves everything, not just tiles.
* Which way to resolve it. Either the art is generated to match the projection (a
  `tile_view_angle` change and a full regeneration) or the projection matches the art
  (cheap, but tiles2 is 13 and tiles 3.0 is 14, so one constant cannot satisfy both).

Reproduce: `python3 tiles/pipeline/pitch.py`

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

## The recommendation, and why it is one change rather than two

The maintainer asked the load-bearing question: is this the game agent's problem today,
or only when the game switches to tiles 3.0? It is today, because a SINGLE value serves
both generations. Leak counts over the full sets, every tile:

| DY | tiles2 (640) | tiles 3.0 (56) |
|----|-------------:|---------------:|
| 13 | 0            | 0 |
| **14** | **3**    | **0** |
| 15 (current) | 629 | 56 |

The three stragglers at 14 are all from ONE tiles2 sheet
(`saturated_grass/base/base_226963752`, tiles 02/08/15) — a sheet to reroll, not a
systematic mismatch. So `ISO_DY = 14` fixes the game as it ships today AND is already
right when 3.0 arrives. 13 is the bulletproof alternative at the cost of 1px more
overlap everywhere.

## The maintainer's verdict, which reverses the recommendation above

Shown tiles2 at 13, 14 and 15 and tiles 3.0 at the same, his call was: **15 looks best
on tiles2** (less zigzaggy) and **14 looks best on tiles 3.0**. So `ISO_DY` stays at 15
while tiles2 is what the game draws, and moves to 14 as part of the switch — the
sequencing he asked about in the first place.

The measurement above is not wrong, but the conclusion I drew from it was. 629/640
tiles2 tiles do leak wall at 15 and that band is real. A CONSISTENT 2px band at every
boundary reads as tile definition rather than as a fault, though, and that is plausibly
part of how the old tileset is meant to look. `pitch.py` answers "does the lattice
close", which is geometry. It cannot answer "is a closed lattice what we want here",
which is art direction. Worth remembering the next time a clean measurement seems to
settle a question about how something should LOOK.

## The outline theory, tested and rejected

The maintainer wondered whether tiles2's outline made 15 correct for it — an outlined
tile showing a border between tiles could be the intended look. Measuring the
silhouette's outermost ring against the pixels two in: grass +0.1, stone +0.7. No dark
border. tiles2's own client docstring agrees: "There is deliberately NO outline." What
leaks at 15 is wall texture, in both generations, so DY=14 is not a new-art preference.

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

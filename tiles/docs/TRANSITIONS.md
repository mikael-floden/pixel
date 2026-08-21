# Transition sets: what they are, what they can't do, how to pick them

A transition set is 16 Wang **corner** tiles from PixelLab's tileset endpoint, indexed
`8*NW + 4*NE + 2*SW + 1*SE` with a set bit meaning the second material. One set covers
BOTH directions — index 0 is all of material A, 15 all of B — so 105 unordered pairs
cover the whole matrix. $0.079 per set, measured.

Generation runs on the maintainer's side (`transition_jobs.py --shell`): the boundary
controls live only on the session-authenticated endpoint. Retrieval is free and runs
here (`transition_import.py`).

## The three rules for drawing them

**Draw at DY=14.** Tiles 3.0's top diamond is 64x28. At a pitch of 15 every tile leaks
a 1px band of wall from under the tile in front — 960 px over a 6x6 field — and that
band is the faint grid across a flat field (`GEOMETRY.md`). It reads as a fault in the
art and is not one.

**Keep the boundary, throw away the fill.** Every generation ships its own opinion of
what each material looks like: measured spread across 11 grass/soil sets is up to
48/255 in the green channel, plus cracks, sparkles and scattered stones (up to 17% of
the grass surface). Mixing sets to vary the boundary therefore checkerboards the field.
`transition_render.retexture()` reads each tile only as a MASK — classified per pixel
against that set's own pure corners — and paints our reviewed materials through it.
Index 0 and 15 pass through as the published tiles verbatim, so an open field is
exactly the art that was starred.

**Paint on the corner lattice, never on cells.** A boundary drawn cell by cell leaves
the set no way to round its own edge.

## What the format cannot do

A corner Wang set fixes the boundary crossing at the midpoint of every tile edge, so a
tile with one odd corner must cut that corner off with a chord — indices 1/2/4/8 and
7/11/13/14 are exactly that cut. Along a boundary that crosses cells diagonally the
cells alternate cut-NE / cut-SW and the edge zigzags by **half a cell, 32 px**, at
every amplitude and every seed. This is geometry, not a bad generation, and no
arrangement of 64px tiles removes it. (Maintainer, on seeing it: *"LOOK it's in the
tile! We can't get rid of it!"* — correct.)

Three things move it, in order of effect:

* **Fit, don't randomise.** Draw the boundary once at pixel resolution and let each
  cell pick the variant whose own pixels agree with it best (`fit_picker`). This is
  what variations are FOR — one set per pair has one shape per index and the staircase
  is forced.
* **Width.** The zigzag is a fixed 32 px, so it scales against the feature, not with
  it. A road 7 cells wide reads as edge texture; 2 cells wide, the zigzag IS the edge.
* **Smaller tiles.** `tile_size: 32` halves the zigzag to 16 px. Untested against our
  64px ground — one generation to find out.

## Picking sets: bumpiness is measurable

`transition_score.py` assembles a half-plane along the map diagonal (the case the
format handles worst, and which lands as a vertical line in screen space so the edge
reads row by row) and reports:

| | |
|---|---|
| `bump` | mean \|second difference\| of the edge's x, in px. Direction *changes* — what reads as a tooth. A straight edge and a smooth diagonal both score 0. |
| `wander` | std of that x. How far the edge drifts off the true line. |
| `clean` | share of scanlines where the boundary is a single flip. Islands of the other material are bumps too. |

Rank by `bump`, tie-break on `clean`. Over the eleven grass/soil sets this reproduces
the maintainer's own pick — 14%/seed 4 scores 1.37, the set he chose by eye as the one
with "no bumps", against 45.8 for the worst. That agreement is what licenses running
the scorer unattended: **generate several seeds per pair, score, keep the best.**

Amplitude alone does not predict it (14%/seed 4 and 14%/seed 5 are the same amplitude
and score 1.37 and 16.5). The seed is the lever; buy seeds, not amplitudes.

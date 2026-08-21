# Transition sets: what they are, what they can't do, how to pick them

**FIRST WORKING VERSION: `bd54bfca4b3b`** (2026-08-21). 17 material pairs generated and
composed, judged in `tiles/lab/` and found good — *"THIS IS THE START OF SOMETHING
GREAT!"* 255 sets, 4080 lossless WebP tiles, 15 boundary settings per pair; grass
against every other material, soil against eight. Not in the game yet: this is the art
and the tooling. (An annotated tag exists locally as `tiles3-transitions-v1` but the
remote refuses tag refs, so the SHA is recorded here instead.)

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

## Picking sets: bumpiness is measurable, and it is per DIRECTION

A set can be clean along one screen diagonal and ragged along another (maintainer, on
23%/seed 4: *"looks good with no bumps in one direction, but then we have bumps in
another direction instead"*), so a single-direction score overrates it.
`transition_score.score_all()` assembles a half-plane along each of the four straight
boundaries the lattice can carry — `screen-vertical` (lattice `r-c`), `screen-horizontal`
(`r+c`) and the two 2:1 iso diagonals (`r`, `c`) — and ranks on the WORST.

| | |
|---|---|
| `bump` | mean \|second difference\| of the edge, measured on a 9px-smoothed profile sampled every 16px. Direction *changes* at CELL scale — the tooth. |
| `grain` | what the smoothing removed: pixel-level raggedness. This is the organic hand-drawn quality, so it is reported and NOT penalised. |
| `wander` | how far the edge drifts off the true line. |
| `clean` | share of 1px slices where the boundary is a single crossing. Islands of the other material are bumps too. |

**The two scales must be separated or the metric inverts.** Measuring second differences
at 1px ranks the best-looking set WORST, because a good set has lots of fine grain.
**The map's own diamond silhouette must be excluded** — it is a material boundary that
runs straight through the middle of the picture, and it inverted the ranking too until
`half_plane_dir` started marking interior cells.

Ranked this way over the eleven grass/soil sets, the top two are the two the maintainer
picked out by eye. Worst-direction bump: 8.4 (23%/seed 4), 13.0 (14%/seed 4), up to 40.2
for the worst. **Amplitude does not predict it** — 14%/seed 4 and 14%/seed 5 share an
amplitude and score 13.0 and 36.0. The seed is the lever: buy seeds, not amplitudes.

`screen-vertical` is the weak axis for 9 of the 11 sets, by 3-5x. That is the boundary
running down the map diagonal, and it is where every tooth the maintainer crossed out
was.

## Mixing: two sets, not eleven

Fitting variants to the curve helps only from a SMALL pool. Measured on the worst
direction: best single set 8.4, fitted over the best two 8.4 (and screen-vertical
improves 7.5 -> 4.6), fitted over the best three 15.0, over all eleven 16.5.

Every set crosses each tile edge at its midpoint, so any two join — but with different
slopes, which puts a kink at every edge. Mixing therefore buys irregularity at the cost
of smoothness: right for a coastline, wrong for a road. **Default to one set per pair,
with a second blended in only where ragged is wanted.**

So the buying rule is: generate several seeds per pair, score all four directions, keep
the best two. At $0.079 a set, 8 seeds across 105 pairs is $66 to choose from.

## THE LAW: never introduce repetition

**No agent decides that a surface should carry texture.** A flat top stays flat.
Ground texture arrives one way only: the maintainer promotes a base tile.

A great tile repeated is still repetition, and repetition is the one thing he cannot
stand: *"YOU CAN NEVER TAKE DECISION TO BRING IN A TOP TEXTURE. DONT EVER BRING IN
REPETITION AGAIN."* Learned three times in a single day — mixing different grass sets
per cell, rolling pure cells across pool sets, and prototyping a textured matrix top —
so it is written down rather than remembered.

`own` below is **not** an exception. It keeps texture the generator already drew
*inside a transition tile*, where every tile is unique and nothing repeats. It never
applies to a field.

## Surfaces: the taxonomy

Every material declares `transition_surface` in `palette.json` (maintainer taxonomy,
2026-08-21, set after reviewing all 17 composed pairs):

| mode | what happens | who |
|---|---|---|
| `own` | The generated art stays; `substitute()` corrects hue and saturation to the palette and the pixel's relief carries through. | grass, light_soil, light_beach, snow, ice |
| `base` | The material's **base tile** is copied into its region, wall included, so the transition mimics the neighbouring field. | the paving twins, parquet_floor |
| `flat` | `base` with a clean-topped base tile: single palette colour on top, published wall below. | dark_mud, grey_stone, black_rock, lava, water, deep_water, slime |

The verdicts that shaped it:

- *"A calm base texture is better than a clean color, but they have to be very very
  subtile."* The corrected generated grass is the reference standard — and near a
  boundary it SHOULD differ from the field: *"grass near a road usually is
  different."* So `own` materials are never overwritten with their base tile.
- Laid surfaces are the opposite: the generator's freehand stones read wrong beside
  the repeating field, so paving and parquet mimic their neighbour. (Copying the base
  tile into EVERY material was tried and was the day's big mistake — right for laid
  surfaces, destructive for organic ones.)
- `flat` is explicitly the fallback: *"the trick we use when we have still not found
  that perfect texture that beats the single base color."* For lava/water/deep_water
  it is probably permanent — the game animates those instead.

**Base tiles** are the coming counterpart: a material may carry several `base_tiles`,
each excellent in repetition, and a field draws them interchangeably to kill the
repeat (*"the small repetition we get can be solved with alternative tiles looking
the same"*). A material with no good base texture yet uses `flat`. Candidate grass
base tiles need no generation: every grass-pair set already carries its own pure
grass tile — hundreds on the account, free to harvest.

Composition is `transition_render.compose_transition()`; the lab builds with it via
`tiles/lab/build_pairs.py`.

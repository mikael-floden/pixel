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

## Building a road: three pools, keyed by the boundary's screen direction

The maintainer's own method, arrived at by hand in the Pair Lab artifact and reproduced
here so it does not live only inside a published page. A cell picks its variant from a
POOL chosen by the direction its boundary runs ON SCREEN - not from one set, and not from
all of them.

| pool | indices | direction |
|---|---|---|
| `horiz` | 1, 7, 8, 14 | 0 degrees, the horizontal spoke |
| `vert` | 2, 4, 11, 13 | 88 degrees, the vertical spoke |
| `x` | 3, 5, 10, 12, **6, 9** | 24 degrees, the four diagonal spokes |

6 and 9 are saddles - two curves crossing in one tile - so they belong with the X.

**His pools for grass/soil** (`amp-seed`; `12-4` is `a12_s4`):

```
x     0-3, 0-5, 3-5, 21-5, 30-1
vert  12-4, 18-4, 21-4, 23-4
horiz 14-5, 15-2, 15-6, 18-6, 21-2, 24-6
```

`vert` is entirely seed 4, which the scorer agrees with independently: seed 4 wins 15 of
23 pairs on worst-direction bump, and `screen-vertical` is the weak axis for 9 of 11
sets. Amplitude does not predict quality; the seed does.

**Within a pool, pick by a hash of the cell** (`hash(r, c, salt)` scaled to pool length),
so a map draws the same road every time.

**PURE CELLS (0 and 15) ALWAYS COME FROM ONE SET.** Rolling them across the pool was
tried and rejected inside an hour: each set's grass is individually excellent but
visibly DIFFERENT, and a field mixing them reads as patchwork - *"individually this is
insanely good tiles. Adding them all together looks like horse shit."* Variation in open
ground comes from base tiles that look the SAME, never from mixing different looks.

**NO FLIPPING.** Mirroring a tile doubles the shape pool for free, and the maintainer
traced chevrons of stray dots through open ground to it: a flipped tile meets its
unflipped neighbour along a seam neither was drawn for. A free variation that costs a
visible artefact is not free.

**Which material is the road is a MAP decision, not a tile property** - index 0 holds
whichever material the description named second, so a pair generated "dark mud to grass"
draws grass as the road. Invert the corner bits (`i -> 15 - i`) rather than regenerating.

Per-variant scores for all 23 generated pairs are published in
`tiles/transitions/scores.json` (bump / wander / clean / grain and the worst direction,
sorted best-first), regenerable with `transition_score.score_all()`.

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

## The OTHER transition: fade tiles (`tiles/fades/`)

A boundary is not the only way one ground becomes another. **Fade tiles** carry BOTH
grounds on one top - grass with black rocks breaking through - so a field drifts toward
the new ground long before any Wang edge is drawn. (Maintainer: *"to start ease in a
change in base tile change long before the base tile change is enforced."*)

**The prompt is tiny and free; the percentage is measured, never ordered.** The
maintainer's architecture, verbatim: *"You will know after the generation how much 'grass
vs black_rock' a tile should be classified as... You must analyse the image."* Prompts
name only the mixture ("grass with black rock") - nothing about shape, placement, amount
or edges. Two rejected approaches, both paid for, both kept on disk (`tiles/blends/`,
`tiles/puddles/`), neither to be re-attempted:

- *Ordered percentages* ("mostly grass, a few small spots of lava", p10..p50): the level
  moves the distribution but does not set it - one p10 sheet's takes spanned 0-30% minor,
  sheet means came out non-monotone. 349 sheets.
- *Prescriptive shape prompts* ("one small patch of {b} in the middle, {a} all around the
  edge"): worked exactly as written and that was the failure - a field of centred ovals,
  rejected outright ("you have generated round spheres... give pixellab freedom"). 126
  sheets.

Phrasing still matters even at three words, so all three tiny forms run per ordered pair
and the measurement sorts the results: measured on grass/black_rock, **"{b} on top of
{a}" draws 100% coverage of b** (no mixture at all), while "{a} with {b}" and "{a} and
{b}" draw genuine mixtures from either side.

**Validity (maintainer rules, 2026-08-28):** a clear majority ground - never 50/50; both
grounds visibly present; edges that still read as the majority. The edge filter is NOT
absolute: a tall feature may cross the rim ("the image is a visualization of a 3D stone
with height"), so `edge_contact` is published as a number and only a rim mostly owned by
the minority rejects. Invalid tiles are omitted from the index, never deleted.

**The consumer surface is the wiki's contract, adopted verbatim** (their board post,
2026-08-28): `tiles/fades/index.json`, schema `tiles3/fade-tiles@1`,
`pairs["<a>__to__<b>"] = [{key, file, pct: {"<a>": 62.5, "<b>": 37.5}}]`. `key` is stable
for the life of the art (verdicts ride on it); `file` is the content-hashed post path,
never constructed by a consumer; `pct` is per ground BY NAME, measured on the exact bytes
in `file`. The raw generator listing is `tiles/fades/sheets.json`. Top-only art: the wall
is meaningless, same as `tiles/tops`.

## Superseded: the blend-tile ladder (`tiles/blends/`, kept on disk)

A boundary is not the only way one ground becomes another. **Blend tiles** are top-only
art that is mostly ground A with ground B creeping in, and they carry no boundary at
all: a field drifts through them *before* any Wang edge is drawn, so the change is
already under way by the time the edge arrives. (Maintainer, 2026-08-27: *"to start ease
in a change in base tile change long before the base tile change is enforced… a gradual
change towards the new ground."*)

They are the second section of the game's Transitions surface, not a variant of the
first: `tiles/patterns/` answers *where exactly* grass stops and lava starts; blends
answer *this is still grass, but lava is coming*.

- **`<dominant>__with__<minor>/p<NN>/`**, NN = percent of the MINOR ground.
  `schema tiles3/blends@1`, `kind blend_top_only`, `use_for "transition"`,
  `wall_is_meaningless true`. Nothing in the tree contains `__over__` — by construction,
  so a blend can never be addressed or rendered as an x-over-y cell.
- **Each ground generates only where it dominates**, p10–p50. The rest of the ladder is
  the other ground's own entry read backwards: *80% grass / 20% lava* IS
  `grass__with__lava/p20`; *20% grass / 80% lava* IS `lava__with__grass/p20`. So a pair
  needs nine distinct mixes, both grounds own five, and 50/50 exists twice as two
  independent takes. 15 grounds ⇒ 1,050 sheets ⇒ $100.80 at $0.096/sheet.
- **The percentage is spoken, not numbered.** A generative model does not measure area,
  so `10%` in a prompt buys nothing; the ladder is worded by how much of B you would
  notice ("a few small spots" → "mixed evenly") and the number survives in the path.
- **The ladder is keyed by the level that was ORDERED** (`ladder[pair][p10..p50]` in
  `tiles/blends/ladder.json`), because that is the only key reliable across all 210
  pairs. Filing tiles by a *measured* mix was built and abandoned: no measure survived
  every pair. Nearest-palette-colour cut black rock in half by brightness and called the
  lighter half deep water; an opponent-hue test cannot run on `black_rock` at all, whose
  clean colour has no chroma; and projecting onto the axis toward the minor ground's
  colour read a dark_mud/grass sheet as 0.2% grass when the art plainly shows grass
  tufts. The generator even draws the same ground differently depending on its partner —
  water is bright in water sheets and near-black inside rock — so no single per-ground
  reference exists either. `minor_seen` is still published per tile as an **advisory**
  sorting hint: accurate on high-contrast pairs, unreliable on low-contrast ones, never
  a label and never a filter. The maintainer reviews and rejects tiles himself.
- **The prompt level is a sampling knob, not a specification.** One p10 sheet's 16 takes
  spanned 0–30% minor and one p40 sheet spanned 0–40%. Expect a spread inside every
  level, and expect some sheets to miss badly (a `deep_water + 50% light_soil` sheet came
  back as almost pure water).
- **Only the dominant portion is aligned.** Top pixels split by nearest clean colour and
  the trimmed median is taken over the A-side alone, then the whole tile moves by that
  one delta. So the A-portion lands exactly on A's clean colour and a p10 tile drops into
  a plain A field with no border, while B rides along keeping its contrast. (Not the
  whole-top median — at p50 that lands between the grounds and drags the tile off BOTH
  palettes. Not per-side snapping — that flattens the drift into two flat colours, which
  is the very thing the ladder exists to avoid.)

# tiles — Tiles 3.0

Third-generation isometric ground tiles. Built **alongside** `tiles2/` (which stays
live and shipping); nothing migrates until this set covers everything the game needs.

> Naming: `tiles2/` = Tiles 2.0, `tiles/` = Tiles 3.0. `tiles2` was never renamed, so
> 3.0 takes the plain name.

## What is actually different

Tiles 2.0 generated *interesting* tiles and then spent months fighting the results in
post-processing. Tiles 3.0 generates *controlled* tiles, and leans on three PixelLab
capabilities that did not exist when 2.0 was built.

### 1. No baked outline — `outline_mode: "segmentation"`

`create-tiles-pro` now takes `outline_mode`. The API default, `outline`, bakes a dark
line around every tile; tiles2 has four separate post-process passes
(`neutralize_outline`, `deseam_diamond`, `fade_outline_alpha`, `clean_top_rim`) that
exist only to fight it, and it still never fully won. `segmentation` generates colour
zones with **no outline at all**.

This one parameter is why the whole library has to be regenerated rather than
reprocessed — the outline is baked into 2.0's pixels.

### 2. Transitions are one call, not a matrix — `/create-tileset`

2.0 generated transitions per ORDERED PAIR and per direction, five sheets each, and
still ended up with thin coverage (9–14 distinct edge signatures per pair). The
`/create-tileset` endpoint produces a connected Wang set between two terrains in a
single generation, and every tile in it connects to every other by construction.

The `pro` pipeline exposes the geometry as parameters instead of hoping the prompt
lands it:

| param | meaning |
|---|---|
| `spread_x` | 0 = steep cliff, 1 = gradual — how far the drop spreads sideways |
| `slope_size` | slope on N/W/E as a fraction of wall height — **what makes a level change walkable instead of a jump** |
| `raggedness` | 0 = straight boundary, 1 = rough. Tiles connect at any value |
| `transition_size` | width of the blended band (0, 0.25, 0.5, 1.0) |

### 3. Ground and wall are separated — "A over B"

A tile is generated with a top surface of one material and side walls of another
("grass over grey stone", "snow over black rock"). Every ground type gets a variant
over every other, so the map agent chooses the walkable TOP and the sideways WALL
independently instead of accepting whatever the generator paired them with.

## The flat base tile

Each ground type's foundation is one tile whose **top surface is a single flat
colour**. Not a stylistic choice — a flat fill has no features to latch onto, so an
arbitrarily large field of the same tile shows no visible repeat. It is what lets the
game paint a whole snowfield or grassland from one tile.

**This is measured, not eyeballed** — `pipeline/flatness.py` scores the top diamond:

- `share` — fraction of top pixels in the dominant colour. **1.0 = perfect.** The headline number.
- `uniq` — distinct colours in the top surface (1 = perfect)
- `std` — mean per-channel standard deviation (0 = perfect)
- `dE` — distance from the type's intended colour, so "flat but wrong colour" cannot pass

Reference points measured on real output:

| | prompt | share |
|---|---|---|
| tiles2-era, `outline` mode | `green` | 0.904 |
| `segmentation` mode | `green` | 0.823 |

### Prompt the COLOUR, not the material

The single most useful finding from the maintainer's own prompt tests: naming the
material returns material texture you cannot flatten — *"clean single colour grass"*
still produces detailed grass blades. Naming the colour returns the flat fill we
want. So every type in `config/tiles.json` carries `color_words` (used to build
prompts now) alongside `material_words` (kept for the later detailed-variant pass).

Lava is the clearest case: ask for lava and you get molten rock with glowing cracks;
ask for *"pure flat dark orange"* and you get the fill.

## Ground types

**Solid** — grass, snow, ice, black_rock, light_beach, grey_stone, light_soil,
dark_mud, parquet_floor, paving_stone
**Liquid** — water, deep_water, lava, slime

## Scope right now

One clean flat base tile per type, and the "A over B" matrix. Detailed/decorated
variants come later. There are **no tiles taller than one level** — what 2.0 called
props is gone; scenery owns objects now, and a scenery object carries no ground with
it, so the same tree can stand on any tile type.

## Layout

```
tiles/
  config/tiles.json      ground types, colour words, prompt templates, house format
  pipeline/
    pixellab_client.py   own copy (per repo convention); adds create_tileset + fetch_tiles
    flatness.py          every measurement, and clears_bar() — THE acceptance test
    palette_snap.py      the postprocess: palette on the top, fringe and wall aligned
    vertical.py          the band a tile shows when stacked on itself (same-over-same)
    no_invention.py      proves the postprocess never invents a colour
    chase.py             roll a cell until it yields candidates; the prompt ladder
    publish.py           promote candidates into review/ with a manifest
    review.py            turn the maintainer's wiki verdicts into rejections
    tombstones.py        permanent rejections AND overrides
    restore.py           rebuild the matrix from PixelLab, free
    reference.py         derive a material's palette from a reference tile
    pixellab_gc.py       delete generations we never kept (--apply is destructive)
    probe.py             generate ONE sheet for ONE prompt and score it (bake-offs)
  matrix/                RAW generations. Gitignored, recoverable — see recovery above.
  review/                published candidates + manifest.json (what the wiki renders)
  generated.json         every tile_id we ever paid for. THE master copy.
  tombstones.json        maintainer verdicts: never-publish and always-publish
  reject_gallery.json    id -> discarded tile, so an override survives regeneration
  hard_cells.json        cells the whole prompt ladder could not fill
```

## Notes

- Art ships as **lossless WebP** (repo default). Never `im.save()` a `.webp` path
  directly — Pillow's default WebP write is lossy and silently resamples pixel art.
- The tile CDN rejects urllib's default User-Agent with a bare 403; `_fetch_image`
  sets one. Without it, downloads fail while generations succeed, which reads as
  "the generation produced nothing".
- A finished generation is fetchable by id (`fetch_tiles`) and costs nothing, so an
  interrupted run never has to pay twice. This is also the whole disaster-recovery
  story — see below.

## The palette is nominated, not measured

A material's colour is not an average of what the generator draws. It is a tile the
maintainer pointed at:

> "This tile is a good palette for 'dark rock'. Try to find exacy what tile it is based
> on the ID and make this the palette that every other dark_rock tile should try to
> mimmic. This means the postprocess script should not really modify this tile at all."

That gives the mechanism its acceptance test, and it is the inverse of the obvious one:
**running the postprocess on the reference must barely change it.** If recolouring the
reference moves it a lot, the palette does not describe the thing the maintainer picked,
and it is the palette that is wrong. `reference.py --check` reports that number for every
material.

    python tiles/pipeline/reference.py --check                       # what would change
    python tiles/pipeline/reference.py --material dark_rock --tile c51bfa48 --write

Eight materials are defined this way so far — `dark_mud`, `black_rock`, `deep_water`,
`grey_stone`, `ice`, `lava`, `light_beach`, `light_soil`. A blanket `--write` deliberately SKIPS them and says so; only naming
one with `--material` re-references it. Without that guard the sweep would quietly re-derive
each from generator averages and overwrite the pick with a success message.

Materials anchored to `tiles2` (grass, snow, water…) are locked harder still and need
`--force`: 3.0 has to read as the same world as the shipping game, and re-deriving grass
from 3.0 output is what once made it a bright yellow-green. Five anchors have now been
deliberately broken by a maintainer's pick, each because 2.0's colour was not the one they
wanted for 3.0:

| material | was | is | what was wrong with it |
|---|---|---|---|
| `grey_stone` | `#72786c` | `#808082` | 2.0's `stone_mountain` is a green-olive grey; they picked a neutral one |
| `ice` | `#a8f0fc` | `#99ced1` | `crystal_ice` is a bright pale cyan; they picked a softer grey-blue |
| `lava` | `#be350e` | `#fb7f10` | too dark, AND self-inconsistent — its wall `#df3c11` was BRIGHTER than its top, so lava blocks were lit from underneath |
| `light_beach` | `#ead2a2` | `#e4c495` | shift on the reference 21.6 -> 7.9 |
| `light_soil` | `#c09c6c` | `#c9ab7e` | shift on the reference 15.5 -> 10.3 |
| `parquet_floor` | `#82523c` | `#a7754b` | too dark, and inverted the same way lava was |
| `paving_stone` | `#72786c` | `#a5a4a8` | shared `stone_mountain` with grey_stone; shift 39.7 -> 3.5 |
| `slime` | `#1fa32c` | `#7aee2f` | shift on the reference 44.2 -> 14.2 |
| `snow` | `#d8e4de` | `#ebf4f6` | shift on the reference 15.3 -> 5.7 |

| `water` | `#428a90` | `#7eb7c7` | shift on the reference 37.9 -> 18.3 |
| `grass` | `#0c483c` | `#2a7039` | see below — neither end was right |

ALL FOURTEEN materials are now the maintainer's own picks. Nothing carries a 2.0 colour any
more, which retires `anchored()` as a practical brake — it still guards against a sweep
re-deriving anything, but there is no longer a tiles2 value left to protect.

### When neither the reference nor what ships is right

> "The grass color palette should be defined as an 'in between' of what we have today and
> what 'grass over grass' #3 gives us. I'm not happy with #3 and I'm not happy with the
> current color palette. Mixing them 50/50 will get to my perfect grass color/palette."

`--mix F` blends the derived colour with the palette entry it would replace. Straight RGB
midpoint, because that is what "50/50" means to the person asking; a perceptual blend would
land somewhere they did not ask for. The stored `source` records both ends and the weight,
so the number can be moved later without re-deriving anything.

    python tiles/pipeline/reference.py --material grass --tile b421e18e --mix 0.5 --write --force

Note what this costs and why it is still right: the mix scores WORSE on the acceptance test
than the reference alone (21.8 against 14.4), because the midpoint is by construction not
what any tile draws. The acceptance test answers "does the palette describe this art"; the
maintainer is answering "what should this material look like", and that is the question that
wins.

### A reference can be several tiles

`paving_stone` was not defined by one tile:

> "The paving_stone palette is defined by every color with a 1 star in 'paving_stone over
> paving_stone' today."

Eight tiles, and for a material meant to VARY that is the better reference — averaging eight
surfaces of the same stone describes the stone, where one tile describes one roll of it.
`--rated N` reads those stars straight out of the wiki's own feedback (`live/feedback/
tiles.json`, another domain's file, opened READ ONLY per PROTOCOL rule 1) and pools the
pixels, so a tile does not get extra weight for having a bigger visible face.

    python tiles/pipeline/reference.py --material paving_stone --rated 1 --textured --write --force

### A material can keep its texture

The flat top is the DEFAULT, not a law. It exists because a featureless surface shows no
repeat across a large field — but that argument does not hold for every material, and the
maintainer named the exception:

> "parquet_floor is not expected to be 'clean'. So a parquet_floor should always maintain
> it's unclean top texture (but the color palette should still align)."

Planks ARE the material; a parquet floor with no grain is not a cleaner parquet floor, it is
a brown rectangle. `paving_stone` is the same — "paving_stone is special the same way
parquet_floor is special" — a paved surface with the paving flattened out of it is not
paving. So `palette.json` carries `"flat_top": false` for both and `snap()` gives
its top the same treatment the walls get — relief kept, hue and saturation taken from the
palette. Set the flag on any other material that wants it (`reference.py --textured` sets it while
referencing); everything else defaults to flat.

The acceptance test reads the flag too. Flattening the top inside `shift()` for a material
that ships textured would score the grain as palette error and make every candidate colour
look equally bad.

Breaking `grey_stone`'s anchor has a side effect worth knowing about: `paving_stone` was
anchored to the SAME 2.0 colour (both were `#72786c`) and still carries it, so the two
stones no longer match. That is now a choice someone has to make rather than an accident of
a shared source.

### The acceptance test has a floor, and it is not zero

"This tile shouldn't change at all" cannot be measured as shift alone, because the top face
is deliberately flattened to one colour — so a reference with any texture in its top can
never reach zero. Decompose it instead: the top's irreducible spread is the mean distance of
its own pixels from their own mean, and a correct palette lands ON that floor.

On the `grey_stone` reference the top's floor is 21.4 and the new palette achieves 21.3 —
i.e. the ONLY thing left is the flattening, and the colour is exactly right. The old palette
scored 29.0 against the same floor, and that gap was the olive cast. Reporting the single
number 21.9 -> 16.5 would have hidden both facts.

`ice` is the same story and larger: floor 13.3, new palette 13.4, old palette 33.2. Two
thirds of what the postprocess was doing to every ice tile in the game was moving it to a
colour the maintainer did not want.

## Which wall pixels are the wall

An X-over-Y wall holds two materials — the side material, and whatever spills over the top
edge — and the postprocess has to tell them apart before it can put each on its own palette
colour. It got that badly wrong, and the maintainer caught it:

> "The 'water over grey_stone' postprocessing you posted looks really fu*ked up. Why did
> your postpy destroy the rock under the water? The rock almost already had correct color
> and you totally destroyed it."

**81.7% of that rock wall was classified as WATER and painted teal.** Not because the rock
was ambiguous — it is light grey and the water is teal — but because the test measured raw
RGB distance to the two palette colours, and in RGB brightness swamps colour. grey_stone's
palette wall is dark (`#45474b`), so light grey rock (`#7c8793`) measured 77 from teal water
and 113 from its own material. The classifier was answering "which palette colour is this
closest to in brightness".

Two changes, in `palette_snap._split_wall()`:

- **chroma, not RGB** — hue and saturation as a vector, so grey sits at the origin and no
  lighting difference can move rock onto water. Value is kept at 0.35 weight, because two
  near-grey materials (snow over grey_stone) have no chroma to separate them.
- **the tile's own colours, not the palette's** — the palette says what a material *should*
  look like; the tile says what the generator *drew*, and on 3.0 grass those differ by a
  lot. The top face is unmixed top material sitting in the same image, so seed from it and
  from the wall's own median.

Neither is the hue-off-a-median inference that shipped magenta, vivid and red walls: nothing
here reads a colour to shift BY. It picks which of two fixed palette targets each pixel is
substituted onto, and `substitute()` still takes hue and saturation from the palette.

Measured over 203 tiles whose wall was independently CONFIRMED to be the side material
(`wall_err <= 10` going in), by how far the wall lands from its own material afterwards:

| classifier | mean | over `MAX_WALL_ERR` | worst |
|---|---|---|---|
| palette + RGB (before) | 4.2 | **7 tiles** | 67.0 |
| palette + chroma | 1.9 | 2 tiles | 37.0 |
| own colours + RGB | 3.1 | 5 tiles | 51.0 |
| own colours + chroma (ships) | **1.6** | **0** | **28.0** |

Zero is the number that matters: no wall that goes in as its own material comes out failing
to be it.

### When the reference only shows the material as a WALL

`deep_water` was nominated on a `grass over deep_water` tile — the material appears as the
side face, not the top — and the maintainer flagged the trap in the same sentence:

> "Everything blue in this tile is the palette of deep_water … and be careful becouse this
> ref-img is 'grass over deep water' and its the dark blue at the bottom that is the color
> palette for other deep_blue tiles."

They were right. **14% of that wall is grass**, the overhang blades the tile was accepted
for. Averaging the region naively returns `#1c3538`, a teal, because a seventh of the
sample is bright green — so the naive read would have made every deep water wall in the
game slightly grass-coloured, taken from the tile chosen *because its grass overhangs
well*. `derive_wall()` rejects it by nearest-of-two against the tile's own top face, and
prints what it threw away: on this tile the rejected pixels average `#64af47` and sit at
the top of the wall. That printout is the check — if the rejected colour ever comes back
looking like the kept one, the split found nothing.

The TOP colour cannot come from such a tile at all (a side face is the shaded one). It is
reconstructed as `reference wall x (same-over-same top / same-over-same wall)`, per channel,
both measured over the same candidates. Taking the same-over-same top directly was tried
and rejected: it is 38 units brighter than the maintainer's pick, which pairs to a lift of
2.00 between one material's two faces — more than any of the fourteen materials shows
(measured range 0.92-1.70). That ships a deep water whose top is visibly a different blue
from its own wall, which is the complaint already made twice about grass.

This costs shift on the existing art (mean 27.6 against the old palette's 23.4) because the
nominated reference is darker than the average deep water the generator draws. That is the
palette doing its job, not a regression.

## Two tile types, and why a rejection is not a deletion

The wall-visible set is the DEFAULT, not the whole library. The maintainer:

> "It's not like I only want clean single color ground in this game. I just want that to
>  be the default. Next is to find nice tiles that doesn't have to care about the wall.
>  It's just a goal to get a nice looking top."

| set | wall | what it must satisfy |
|---|---|---|
| **wall-visible** (all of `tiles/` today) | seen — it becomes every cliff face | the whole bar: seam, wall quality, the transition, materials |
| **top-only** (next) | never seen; the tile is surrounded | the top surface alone |

So a rejection during the wall-visible review means *"the wall is not good enough to be
SEEN"*, which says nothing about the top. Those tiles are **deferred**, not deleted —
`tombstones.json` holds them under `deferred` with `from_set: "wall_visible"`, and the
top-only review will draw from exactly that pool.

> "So instead of regenerating, we might be able to reuse tiles from this set that didn't
>  have a wall good enough."

**Nothing in this domain is deleted by a maintainer verdict.** `review.py` used to stamp
a generation `rejected` once all its candidates were, and `pixellab_gc --apply` deletes
what is marked rejected; that is gone. The value of not deleting is already proven — the
maintainer went through the reject pile and overruled the filter on 40 tiles it had
discarded, and separately a seam bug meant 46% of everything ever generated was being
rejected for a defect that does not exist in the shipped tile. Both were recoverable
only because the art was still there.

`pixellab_gc --apply` remains the one destructive command in the domain. Treat it as
requiring the maintainer to ask for it by name.

## If the machine dies: getting the raw tiles back

**`tiles/matrix/` is gitignored and it is NOT the master copy.** It holds ~18,800 raw
tiles across ~1,200 sheets, 86 MB, and almost all of them are rejects the filter threw
away. It exists only on whatever machine last ran the pipeline, and the pipeline usually
runs in an ephemeral container. Assume it is already gone.

Nothing is lost when it goes, and **nothing has to be paid again**, because
`tiles/generated.json` IS committed and holds every sheet's `tile_id`. A completed
generation re-downloads for free — you already paid for it — so the registry is the
master copy and the matrix is a cache.

```sh
export PIXELLAB_API_KEY=...            # from .env; never committed
python3 tiles/pipeline/restore.py            # what exists vs what is on disk
python3 tiles/pipeline/restore.py --verify 8 # prove the round-trip still works
python3 tiles/pipeline/restore.py --fetch    # re-download everything missing
python3 tiles/pipeline/publish.py --top 3 --clean   # rebuild the review set
```

`--verify` is the one that matters, and it compares PIXEL FOR PIXEL rather than checking
that something came back. Measured 2026-08-19: **10 of 10 sheets byte-identical across
160 tiles, and all 1,180 live ids retrievable, 0 missing.** Re-run it before trusting
any of this — the claim is only as good as its last test.

### What would actually destroy the art

Only deletion on PixelLab's side, and the only thing that deletes is ours:
`pixellab_gc.py --apply` permanently removes generations marked `rejected` (39 of them
at the time of writing). **A rejection does not need that.** `tombstones.json` already
guarantees a rejected tile is never published again, which is the behaviour the
maintainer asked for; deleting the generation as well buys tidiness on the PixelLab
account and costs the ability to change your mind.

That is not hypothetical. The maintainer went through the reject pile
(`tiles/reject_gallery.json`, published as an artifact) and overruled the filter on 40
tiles it had discarded — recovering, in one pass, art that a `--apply` run would have
made unrecoverable. Their reasoning is worth keeping:

> "To me what you discard before I can see them has been blind to me, so I have never
>  been able to relax your filter - only make it stronger."

So: run `pixellab_gc` in its default dry-run mode freely, and treat `--apply` as
requiring the maintainer to say so.

### Also committed, also load-bearing

| file | why losing it hurts |
|---|---|
| `generated.json` | every `tile_id`. Without it the raw art is unrecoverable even though it still exists on PixelLab. |
| `tombstones.json` | the maintainer's 82 rejections and 40 overrides. Losing it re-asks for verdicts they already gave. |
| `reject_gallery.json` | id → discarded tile, so an override survives regeneration. |
| `hard_cells.json` | which cells the whole prompt ladder failed on. |
| `review/` | the published candidates the wiki renders. Rebuildable from the matrix. |

## The review set (what the wiki renders)

`tiles/review/manifest.json`, schema **`tiles3/review@2`**. Every candidate carries
BOTH states, because the maintainer judges the postprocess as well as the art and
cannot do that from one image:

| field | meaning |
|---|---|
| `before` | the generator's output, untouched. Repo-relative path to a lossless WebP. |
| `after`  | what the game gets. Same tile with the top surface snapped to the shared palette colour and the outline's spikes clipped. **The wall is not touched — 0 px changed** — which is why the border where the top material meets the rock survives. |
| `file`   | alias of `after`, kept so anything written against `@1` still resolves. |
| `palette_top` | the hex `after` was snapped to. |
| `overhang` | 0–1, how much of the top material tufts down over the wall. Gate **0.25**, calibrated on the maintainer's verdict across all 14 grass cells (kept ≥ 0.36, rejected ≤ 0.10) — but they have since accepted tiles at 0.045–0.24 from the reject pile and said why: *"I think you maybe expect it to be a giant overhang. As long as there is some I feel it's good enough."* The floor belongs near 0.05; 15.7% of tiles measure exactly 0.000, so a low floor still catches "no transition at all". |
| `wall_score` | tiling / discretion / structure; a dead flat cliff scores near 0. |
| `top_share` | flatness of the RAW top. Deliberately **not** a gate — the postprocess overwrites the top anyway, and gating on it discarded 182 tiles that were already seamless once shipped. |
| `tile_id` | the PixelLab generation, so a rejection can actually delete it. |
| `key` | `tiles/<cell>/<sha1(src)[:8]>` — derived from the SOURCE TILE, not its rank. It used to be the position (`/0`, `/1`), and a position is not an identity: un-publishing a rejected tile let the next one slide into slot 0 and inherit the maintainer's rejection *and their comment*. 126 rejected keys were still in the manifest, re-pointed at art they had never seen, and two verdicts were applied to the wrong tile. |
| `maintainer_pick` | this tile failed a gate and the maintainer overruled it. Publishes regardless, sorts first. |

`needs_regeneration` on a cell means no candidate in it clears the spill gate — the
transition was never drawn, and no amount of re-ranking will produce one.

Paths are **repo-relative**, matching how the wiki addresses every other domain's art.
Verdicts are read back from `live/feedback/tiles.json` in the `pixel-wiki-feedback@1`
format the scenery domain already uses.

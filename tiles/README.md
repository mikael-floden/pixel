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
    flatness.py          the acceptance test for a flat base tile
    probe.py             generate ONE sheet for ONE prompt and score it (bake-offs)
  probes/                bake-off output, one dir per strategy
```

## Notes

- Art ships as **lossless WebP** (repo default). Never `im.save()` a `.webp` path
  directly — Pillow's default WebP write is lossy and silently resamples pixel art.
- The tile CDN rejects urllib's default User-Agent with a bare 403; `_fetch_image`
  sets one. Without it, downloads fail while generations succeed, which reads as
  "the generation produced nothing".
- A finished generation is fetchable by id (`fetch_tiles`) and costs nothing, so an
  interrupted run never has to pay twice.

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
| `overhang` | 0–1, how much of the top material tufts down over the wall. The gate is **0.25**, calibrated against the maintainer's own verdict on all 14 grass cells: everything they kept scored ≥ 0.36, everything they rejected ≤ 0.10. |
| `wall_score` | tiling / discretion / structure; a dead flat cliff scores near 0. |
| `top_share` | flatness of the RAW top. Deliberately **not** a gate — the postprocess overwrites the top anyway, and gating on it discarded 182 tiles that were already seamless once shipped. |
| `tile_id` | the PixelLab generation, so a rejection can actually delete it. |
| `key` | stable id (`tiles/<cell>/<n>`) for `live/feedback/tiles.json`. |

`needs_regeneration` on a cell means no candidate in it clears the spill gate — the
transition was never drawn, and no amount of re-ranking will produce one.

Paths are **repo-relative**, matching how the wiki addresses every other domain's art.
Verdicts are read back from `live/feedback/tiles.json` in the `pixel-wiki-feedback@1`
format the scenery domain already uses.

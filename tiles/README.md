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

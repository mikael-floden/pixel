# tiles — Tiles 3.0

Third-generation isometric ground tiles — THE tile library the game renders.
(`tiles2/`, Tiles 2.0, was deleted 2026-09-09 with every world it painted; history
in git. Maintainer: "We will never go back to the tile2 system again.")

> Naming: `tiles/` = Tiles 3.0; the plain name was reused from the retired v1.

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
dark_mud, parquet_floor, brown_paving_stone, grey_paving_stone
**Liquid** — water, deep_water, lava, slime

`paving_stone` is a GENERATION alias, not a ground type: `config/tiles.json` still
generates under it, and `publish` expands each such cell into the two above via their
`generated_as` fields, never publishing the alias name (*"The same paving_stone will
generate both a brown and a grey version."*). 16 types in `config/palette.json`.

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
    review_prune.py      remove x-over-y candidates rejected on EVERY face from manifest + git
    tops_review.py       remove rejected top-only tiles (subtle/detail) from index + git
    tombstones.py        permanent rejections AND overrides
    restore.py           rebuild the matrix from PixelLab, free
    reference.py         derive a material's palette from a reference tile
    notes.py             the maintainer's written notes — surfaced, never acted on
    pixellab_gc.py       delete generations we never kept (--apply is destructive)
    probe.py             generate ONE sheet for ONE prompt and score it (bake-offs)
    transition_patterns.py  distil tiles/transitions into the pattern library
    transition_plates.py    build tiles/plates from the maintainer's approvals
  matrix/                RAW generations. Gitignored, recoverable — see recovery above.
  review/                published candidates + manifest.json (what the wiki renders)
  patterns/              the boundary, material-independent: 18 patterns x 16 Wang masks
  plates/                the surfaces the boundary divides: one plate per ground/tile
  generated.json         every tile_id we ever paid for. THE master copy.
  tombstones.json        maintainer verdicts: never-publish and always-publish
  notes_seen.json        which of their written notes the agent has actually read
  review_lock.json       cells they have finished reviewing; publish may only shrink these
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

## A review is two things, and only one of them is automatable

**THE VERDICT is mechanical.** Reject / approve / stars is a fact about a file: "do not
publish this tile again". `publish.py` applies any pending verdict before it touches the
review folder, and re-checks afterwards that nothing the maintainer deleted is still in
the set it just wrote. That automation earned itself — the apply used to live in whichever
shell script happened to call publish, it got skipped, and they were handed a brand-new
build still containing nine tiles they had removed: *"Why do I see something I have
removed if you have just built a new version. I understand absolutely nothing now."*

**THE NOTE IS NOT.** A note is a person telling the agent how to fix the generator, and no
script can act on one:

> "It's meant that you read them. I might have a comment to you. It should be in your
> readme and not a script to automate it. How do you automate reading my comments?"

You don't. And the hazard is specific: automating the verdict means the tile quietly
disappears — correctly — while the sentence attached to it is never read. So `notes.py`
does the only honest thing a script can do here, which is make an unread note impossible
to miss. `publish` prints every unread note in a block before it runs. Acknowledging is a
separate deliberate act (`--ack`) and is a lie if run without reading, which is the
property that keeps it worth anything.

    python tiles/pipeline/notes.py          # notes not yet read
    python tiles/pipeline/notes.py --all    # every note ever left
    python tiles/pipeline/notes.py --ack    # after actually reading them

**READING THE NOTES IS THE AGENT'S JOB.** Not a step in a pipeline — a thing to do, with
the same seriousness as looking at the art. Every note in the first pass changed this
repo, which is the argument for it:

| what they wrote | what it became |
|---|---|
| "looks like Y over X" (22 notes) | `swapped_err()` — the swapped-material gate |
| "not enough lava on the ground" (14) | `top_contamination()` and the contamination tier |
| "You might have to call water something else like *blue*" | the colour-word trick: deep_water-over-grass went 100% backwards to 12% |
| "Paving stones are not supposed to be clean" | `flat_top: false` |
| "the word *floor* will get the AI to think the wood should be at the top" | still open — a prompt change for parquet_floor |

Not one of those was derivable from the pixels. They came from a person looking at the
art and saying what was wrong with it.

## The docs — `tiles/docs/`

The measured stories of the review pipeline live in `docs/REVIEW.md` (the
nominated palette, `seam_px`, which wall pixels are the wall, plates, the two
tile types, recovering raw tiles), beside `docs/GEOMETRY.md`,
`docs/TRANSITIONS.md` and `docs/BAKEOFF.md`; this README keeps the rules
(root doc law, 2026-09-09).

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

**A rejected tile leaves git** (maintainer 2026-09-11: "remove tiles I have rejected
everywhere and is not good enough for anything and never referenced"). `review_prune.py`
drops an x-over-y candidate whose every voted face (`#top`, `#wall`) is rejected;
`tops_review.py` drops a top-only tile whose `#top` is rejected. Both keep, and report,
anything something still DRAWS: a base-set member (`live/tuning/base_tile_sets.json`,
`tiles/resolve.json`), a wall donor in `live/tuning/top_walls.json` ("the wall might
still have been accepted" - the game draws that wall under other tiles), a plate-pool
member, a games2 fixture. `tile_walls.json` `top_only` is the wall's own rejection and
never keeps. **A base-set member stays whatever its detail verdict** (maintainer
2026-09-12: "99.99% of the time a detail tile is not part of a base tile. But this is
different sets so ofc it may happen ... it's not a rule that is forbidden"). "Not a
detail" and "in my set" are two independent judgements, so a rejected tile that his set
draws is not a conflict to put to him - it is kept, silently, until he drops it from the
set. The bare-key verdict from before faces existed (2026-08-21, every
candidate carries an approval there) counts only while no faced verdict is newer -
read beside a later `#top` rejection it kept every rejected tile. A top-only sheet
shrinks with the verdict (its `meta.json` lists the `removed` tiles, so `is_complete`
stays true); a sheet that lost EVERY tile keeps `meta.json` as a tombstone with
`n_tiles` 0 and leaves the index, so the seed is never bought again.
`tiles/tops/removed.json` is the durable record - the wiki prunes a feedback entry
once the tile leaves the index. A rejected candidate's source is deferred in
`tombstones.json` so `publish.py` cannot bring it back; a cell left empty is flagged
`needs_regeneration`.

## Art immutability (LAW, 2026-08-27)

A published art file is NEVER rewritten. A pass that regenerates a tile writes a NEW
filename carrying the content hash (`tile_00.<sha8>.webp`, `<n>_textured.<sha8>.webp`),
updates the index/manifest to point at it, and deletes the stale name. Consumers read
art paths from the index, never construct them by convention. (The one time art was
rewritten in place under stable names, the maintainer's phone rendered two cache
generations of the same file side by side and it read as the game being destroyed -
"What is real and what is a cache bug? Noone knows now." With hashed names a stale
cache can only show a coherent old version or a missing image, never a mix. Raw
generator output is exempt: it is written once at generation and never regenerated.)

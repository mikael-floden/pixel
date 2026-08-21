# The transition lab

## THE LAW: never introduce repetition

**No agent decides that a surface should carry texture.** A flat top stays flat.
Ground texture arrives one way only: the maintainer promotes a base tile. A great
tile repeated is still repetition, and repetition is the single thing he cannot
stand — *"YOU CAN NEVER TAKE DECISION TO BRING IN A TOP TEXTURE. DONT EVER BRING IN
REPETITION AGAIN."*

Three violations in one day, all mine, all rejected on sight:

1. Mixing 15 different grass sets per cell — *"individually this is insanely good
   tiles. Adding them all together looks like horse shit."*
2. Rolling pure cells across the pool sets — same fault, smaller.
3. Prototyping a textured top for the x-over-x matrix — a patterned grass tiled 25
   times, shown to him unprompted.

`transition_surface: own` is **not** an exception. It keeps texture the generator
already drew *inside a transition tile*, where every tile is unique and nothing
repeats. It never applies to a field.

The pages the maintainer judges transitions in. They are built here and published as
Artifacts; the published page is a snapshot, so rebuilding and republishing is how a
change reaches him.

    python3 tiles/lab/fetch_pairs.py     # pull generated sets off PixelLab (free, API key)
    python3 tiles/lab/save_tiles.py      # write them into tiles/transitions/ as WebP
    python3 tiles/lab/build_pairs.py     # compose + pack -> pairs_view.json
    # then inject pairs_view.json into lab2_template.html at __DATA__ and publish

**A generated Wang set already tiles seamlessly** — that is what it was generated to
be — and its surface is the texture the game wants. The only thing wrong with it is
that every set invents its own green and its own sand, so two sets side by side
disagree. `retexture_palette()` fixes exactly that and nothing else: classify each
pixel into one of the two materials, then run the wall's own `substitute()` over each
region so hue and saturation come from the palette while the pixel's own relief
carries through.

REJECTED, and expensively (a whole afternoon): discarding the art and repainting from
our published ground tiles, with a blended collar to rebuild the boundary. It threw
the texture away, it did not fix the seams — because the seams were caused by the
repainting — and nobody asked for it. *"If you think we want a single clean color in
this game you are wrong. We use the base color to transition without a seam."*
Correcting colour in place cannot introduce a seam, because nothing moves.

## Traps paid for

- **Index 0 is the material named SECOND** in the generation description, 15 the
  first. Do not measure it — a colour test agreed on 12 of 13 pairs and read a
  near-black brown as a dark green on the thirteenth. The request already says it.
- **`_diamond()` was a pixel short** at every extreme. Use `top_face(alpha)`, which
  takes the top face from the tile's own silhouette (the wall is a constant 17-row
  extrusion). The old mask made a closing lattice look like it leaked at every pitch.
- **A palette PNG loses its transparency index** on save — Pillow re-packs the palette
  and the index moves, and every tile comes back opaque. Quantise for size, then put
  the real alpha back and save RGBA.
- **flat_top false means the surface IS the material.** brown_paving_stone,
  grey_paving_stone and parquet_floor keep their texture; flattening them left a blank
  slab.
- **A line inside the ground is not necessarily a seam.** Four fixes aimed at the tile
  edge missed because the offending pixels sat at rows 8-19 — the middle of the tile.
  Measure where they are before deciding what they are.

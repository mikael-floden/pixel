# Flat base tile — prompt bake-off

How the tiles 3.0 base-tile prompt was chosen. Eight strategies, one paid generation
each (16 tiles per sheet), through an identical pinned harness (`pipeline/probe.py`)
so the **only** variable was the prompt text. Scored by `pipeline/flatness.py`.
Total cost ~$1.

Target for the bake-off was grass at `#3f8a3a`.

## Results

`share` = fraction of top-surface pixels in the single dominant colour (1.0 = a
perfectly flat top). `dE` = perceptual distance from the target colour. `geom` = tiles
that are still a usable iso tile (full canvas width + a front face for the wall).

| strategy | share | uniq | dE | geom | verdict |
|---|---|---|---|---|---|
| `over_probe` — flat top + named wall material | 0.995 | 4 | 11.1 | 16/16 | **PASS** |
| `hex_anchor` — `solid uniform #3f8a3a green, one single flat colour, completely smooth, no texture` | 0.992 | 3 | **5.7** | 16/16 | **PASS (winner)** |
| `matte_face` | 1.000 | 1 | 28.4 | 16/16 | flat, wrong colour |
| `monochrome` | 1.000 | 1 | 31.8 | 0/16 | **rejected — not full width** |
| `anti_texture` — long negation list | 0.992 | 4 | 24.2 | 16/16 | flat, wrong colour |
| `paint_swatch` | 0.992 | 4 | 25.3 | 16/16 | flat, wrong colour |
| `numbered_flat` — 16 numbered "flat green" | 0.935 | 8 | 29.4 | 16/16 | read as a variety sheet |
| `user_phrase` — `single color 100% pure green` | 0.825 | 11 | 27.8 | 16/16 | visible grass blades |
| `green` (segmentation) | 0.823 | 8 | 40.6 | — | baseline |
| `green` (outline, tiles2-era) | 0.904 | 8 | 6.1 | — | baseline |

## What this settled

**Flatness is not the hard part.** Five different prompts cleared 0.99, and two hit a
literal 1.000. Choosing on flatness alone would have picked the wrong prompt.

**Colour accuracy is the hard part, and only an explicit `#hex` solves it.** Every
prompt that named the colour in words alone landed 21–31 dE away — visibly the wrong
green. Pinning the hex got 5.7. That is why every template in `config/tiles.json`
carries `{hex}`, and why `dE` is an acceptance criterion rather than a note.

**Naming the material is read as a style hint, not an instruction.** `single color
100% pure green` returned ordinary grass-on-dirt blocks with visible blades (0.825).
This confirms the maintainer's own finding — ask for the colour, not the material.

**`segmentation` alone flattens nothing.** Same prompt (`green`), only the mode
changed: 0.904 → 0.823, and the hue drifted badly (dE 40.6). Its value is removing the
baked outline, which is real but separate.

**A perfect score can mean a degenerate tile.** `matte_face` and `monochrome` scored
1.000 by returning a plain shaded cube — one uniform colour, no distinct wall
material, and in `monochrome`'s case art too narrow to tessellate. Flawless by the
metric, useless as a tile. This is why `flatness.py` also gates on geometry, and why
the acceptance rule is `share ≥ 0.98 AND dE < 12 AND geom_ok`.

**"A over B" works today.** `over_probe` asked for a flat green top with grey stone
walls and got exactly that — flat top, clean two-tone grey wall, no outline. The
separation of walkable surface from sideways wall does not need a new API feature,
only the prompt. Its colour drifted more than `hex_anchor` (dE 11.1, and hue varied
across the sheet), so the production template hex-anchors **both** surfaces.

## Method note

The first version of `flatness.py` assumed tiles fill a centred 64px canvas. Most do,
but `monochrome` came back 57px wide centred at x29, and the fixed mask sampled its
side walls as if they were surface texture — scoring a perfectly flat tile at 0.568.
The mask now derives the diamond from each tile's own opaque bounding box. Worth
recording because the failure was silent: a plausible-looking score for the wrong
reason.

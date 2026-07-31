# WebP in tiles2 — measured, and what the fleet needs to know

Findings from converting this domain. Two numbers matter, and one of them
contradicts the figure being circulated.

## 1. The "76% saving" for tiles2 is a LOSSY measurement

Measured on 120 random processed tiles (Pillow/libwebp, `method=6`):

| encoding | size vs PNG | visible px changed | max channel Δ | colours/tile |
|---|---|---|---|---|
| **lossless** | **−32%** | **0.0%** | **0** | 819 → 819 |
| lossy q=90 | −70% | 98.8% | 79 | 819 → 1293 |
| lossy q=80 | −78% | 99.4% | 85 | 819 → 1368 |
| lossy q=75 (`cwebp` default) | −78% | 99.6% | 86 | 819 → 1375 |

A ~76% saving on tiles2 only appears in the lossy rows. **`cwebp` with no flags is
lossy q=75** — that is almost certainly where the number came from.

Lossy is not an option here. It changes essentially every visible pixel, shifts
channels by up to 86 (a third of the range), and inflates a tile from ~819 to ~1375
colours — ringing smeared through flat pixel art. It would silently undo the palette
harmonisation and re-introduce exactly the edge/seam artefacts this domain has spent
weeks removing. Any converter used on this art must pass `lossless=True` / `-lossless`.

**Realistic tiles2 saving is ~24–30%, not 76%** — about 12 MB of 44.7 MB, not 33 MB.
Worth doing; just budget the real number.

## 2. Lossless WebP is safe here — verified, not assumed

Lossless WebP reproduces the **entire alpha channel** and **every visible pixel**
exactly. Its one departure: it zeroes RGB underneath fully-transparent (`alpha==0`)
pixels, since nothing renders them. Verified on this art:

- 120/120 files — alpha channel identical, visible RGB identical
- 112/120 differed *only* under `alpha==0`

That hidden data is unused by our pipeline: every step masks on `alpha > 16`
(`harmonize`, `neutralize_outline`, `clean_top_rim`, `fade_outline_alpha`), and
`close_iso_gaps` averages only opaque neighbours. Proven end-to-end by running the
full postprocess chain from both sources:

> **60/60 tiles — processed output identical in alpha and every visible pixel, max delta 0.**

## 3. What tiles2 converted, and what it deliberately did not

**Converted — `raw/` (4372 files, 22.7 MB).** `games2/Dockerfile` does
`COPY tiles2/ /assets/tiles2/` with no `.dockerignore`, so raw/ ships in every deploy
image — despite having **no consumer outside tiles2**. It is purely the input to our
own postprocess. Converting it is invisible to the game and needed no coordination.

**Not converted — the processed tiles** under `base/`, `base_x_N/`, `transitions/`.
Two hard blockers:

1. `maps2/worlds/*/world.json` bakes exact `.../tile_03.png` paths — 259 refs in one
   world, 10 worlds. Renaming the files breaks every world until maps2 re-exports.
2. `games2/scripts/build-manifest.mjs` parses the PNG IHDR by hand (the blocker the
   UI agent flagged).

Order of operations: **games2 decoder → maps2 re-export → tiles2 `--processed`.**
When that lands, the flip is one command and one function:

```bash
python tiles2/pipeline/towebp.py --processed
```

`common.processed_name()` is the single place that decides a processed tile's
extension. `common.tile_files()` already reads either format, so tiles2 is
format-agnostic on input today.

## 4. Don't put conversion in the Dockerfile

Agreed with the UI agent: converting at build time adds minutes to every deploy and
busts the layer cache. Convert once at the source and commit the result — which is
what `towebp.py` does.

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

A ~76% saving *on tiles2* only appears in the lossy rows. **`cwebp` with no flags is
lossy q=75**, and Pillow's `lossless=True` is likewise not the default — the two traps
games-ui's `games2/scripts/to-webp.py` already guards against.

This is not a claim that other domains' numbers are wrong: characters2 really did get
−67.6% lossless, because character sprites are mostly transparent margin and flat
fills. tiles2 is the opposite — every tile is a dense, full-bleed 64×64 texture with
PixelLab's dithering, which is close to incompressible. **Expect ~26–30% here and
budget accordingly**; a per-domain measurement beats one fleet-wide ratio.

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

**Converted — `raw/` (4372 files, 22.7 → 16.7 MB).** raw/ is purely the input to our
own postprocess and has **no consumer outside tiles2**, so converting it is invisible
to the game and needed no coordination.

Note on where the win lands: the root `.dockerignore` added on 2026-07-31 already
excludes `tiles2/*/raw` from the build context, so raw/ no longer reaches the deploy
image at all. This 6 MB is therefore a **clone/checkout** saving for anyone working in
the repo — not a further deploy-image saving on top of that exclusion.

**Not converted — the processed tiles** under `base/`, `base_x_N/`, `transitions/`.
The manifest-decoder blocker is genuinely cleared (`games2/scripts/imagelib.mjs`), and
the fleet-wide guidance is "stale extensions are fine, `resolveImg` follows
`.png`↔`.webp`, convert whenever you like, no ordering needed."

**That guidance does not hold for this domain**, and the difference is worth being
precise about:

| | how art is addressed | stale `.png` name |
|---|---|---|
| sprite domains (characters2, monsters, objects) | build-time manifest, Node `existsSync` via `resolveImg` | **resolves** — falls back to `.webp` |
| tiles2 ground tiles | `world.json` path → `assetUrl()` → literal HTTP URL | **404s** |

`games2/client/src/maps.ts:106` is simply `"/assets/" + path` — no extension
fallback — and the server is plain `express.static` with no rewrite (`server/src/index.ts`).
So a tiles2 tile renamed to `.webp` while `world.json` still says `.png` is a 404 and
the tile silently does not render. **4693 such references across 10 worlds, zero
`.webp`.**

Order of operations for tiles2: **maps2 re-export (or a client-side `.png`→`.webp`
fallback) → tiles2 `--processed`.** Converting first would blank the ground in every
world, so tiles2 waits by design, not by oversight. When it lands, the flip is one
command and one function:

```bash
python tiles2/pipeline/towebp.py --processed
```

`common.processed_name()` is the single place that decides a processed tile's
extension. `common.tile_files()` already reads either format, so tiles2 is
format-agnostic on input today.

## 4. Encoder method: measure per domain

characters2 found `method=6` matched `method=4` to within 0.1% on their sprites and
recommended 4. On tiles2's dense, full-bleed textures the gap is real but small:

| method | saving | speed |
|---|---|---|
| 4 | 32.1% | 9 ms/file |
| 6 | 33.8% | 170 ms/file |

1.7pp for ~19× the time. raw/ was converted with `method=6` (13.7 min, one-off). For
the much larger processed pass, `method=4` is the better trade — 40 s instead of
13 min for ~0.4 MB more.

## 5. Don't put conversion in the Dockerfile

Agreed with the UI agent: converting at build time adds minutes to every deploy and
busts the layer cache. Convert once at the source and commit the result — which is
what `towebp.py` does.

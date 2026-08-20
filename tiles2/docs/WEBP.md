# WebP in tiles2 — the laws, with the measurements behind them

**Status: migration complete (2026-07-31).** The whole domain is lossless
WebP — raw (22.7 → 16.7 MB) and processed (22.6 → 15.4 MB), zero PNGs.
`common.TILE_FORMAT` / `common.processed_name()` decide the container in ONE
place; every tile write goes through `common.save_tile()`.

## 1. LOSSLESS ONLY — Pillow's and cwebp's defaults are both lossy traps

Measured on 120 random processed tiles (Pillow/libwebp):

| encoding | size vs PNG | visible px changed | max channel Δ | colours/tile |
|---|---|---|---|---|
| **lossless** | **−32%** | **0.0%** | **0** | 819 → 819 |
| lossy q=90 | −70% | 98.8% | 79 | 819 → 1293 |
| lossy q=80 | −78% | 99.4% | 85 | 819 → 1368 |
| lossy q=75 (`cwebp` default) | −78% | 99.6% | 86 | 819 → 1375 |

Lossy changes essentially every visible pixel, shifts channels by up to a
third of the range, and smears ringing through flat pixel art — it would
silently undo the palette harmonisation and re-introduce the edge/seam
artefacts this domain removed. `cwebp` with no flags is lossy q=75; Pillow's
`lossless=True` is not the default. Never `im.save()` a `.webp` path
directly — use `common.save_tile()` (or `games2/scripts/to-webp.py`, which
verifies round-trips).

## 2. Budget the REAL ratio: ~26–34% here, not "76%"

Any circulated ~76% saving for tiles2 was a **lossy** measurement.
characters2's −67.6% lossless is real *for sprite art* (mostly transparent
margin + flat fills); tiles2 tiles are dense, full-bleed, dithered 64×64
textures — close to incompressible. **A per-domain measurement beats one
fleet-wide ratio.**

## 3. Why lossless is safe here — verified, not assumed

Lossless WebP reproduces the entire alpha channel and every visible pixel
exactly; its one departure is zeroing RGB under fully-transparent
(`alpha==0`) pixels. That hidden data is unused: every pipeline step masks on
`alpha > 16` (`harmonize`, `neutralize_outline`, `clean_top_rim`,
`fade_outline_alpha`), and `close_iso_gaps` averages only opaque neighbours.
Verified: 120/120 files alpha- and visible-RGB-identical, and the full
postprocess chain run from PNG vs WebP sources produced **60/60 identical
outputs, max delta 0**.

## 4. Encoder method: `method=4` for bulk passes

| method | saving | speed |
|---|---|---|
| 4 | 32.1% | 9 ms/file |
| 6 | 33.8% | 170 ms/file |

1.7pp for ~19× the time — use 4 for anything repeated (40 s vs 13 min over
the processed set). (characters2 measured the same conclusion on sprites.)

## 5. The ordering trap that made tiles2 convert LAST (paid for)

Extension staleness is survivable only where something resolves it:

| | how art is addressed | stale `.png` name |
|---|---|---|
| sprite domains (characters2, monsters, scenery) | build-time manifest, Node `existsSync` via `resolveImg` | **resolves** — falls back to `.webp` |
| tiles2 ground tiles | `world.json` path → `assetUrl()` → literal HTTP URL | **404s** — the ground silently blanks |

Converting processed tiles before the consumers could resolve them would have
blanked the ground in every world (4,693 stale references at the time). The
flip was unblocked by TRANSITIONAL runtime fallbacks in games2
(`WorldScene.loadImageEitherExt` + a server-side `.png`↔`.webp` sibling
middleware, 2026-07-31) — but those were **removed the same day** once
measured clean and must not be reintroduced (games2 law: a stale extension
must 404 loudly; the fix belongs in the domain's exporter — a runtime
fallback masked maps2's un-re-exported worlds for a day). Today maps2 worlds
reference `.webp` throughout and **nothing resolves a stale tiles2 path at
runtime**. **Law for any future container change: consumers first, then flip
`common.processed_name()`** — it is the single place the processed extension
is decided, and `common.tile_files()` reads either format on input.

## 6. Never convert in the Dockerfile (agreed with the UI agent)

Build-time conversion adds minutes to every deploy and busts the layer cache.
Convert once at the source with `pipeline/towebp.py` and commit the result.

Note: `tiles2/*/raw` is excluded from the deploy image by the root
`.dockerignore`, so raw/'s WebP win is clone/checkout size only, not deploy
size.

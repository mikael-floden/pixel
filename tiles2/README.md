# tiles2 — Tiles 2.0, the live isometric ground-tile library

The tile library the game ships today. Organised around **specifically-named
ground types**, generated in a loop, with a raw→processed pipeline so every
tile of a type reads as one material, and first-class **transitions** between
types. (Successor of the retired first-gen tile registry; `tiles/` is now
**Tiles 3.0**, built alongside — nothing migrates until it covers everything.)

> **Map / game designers:** start with `docs/DESIGNER_GUIDE.md`. Per-tile
> machine-readable metadata contract: `docs/METADATA.md`. Elevation props:
> `docs/ELEVATION.md`. Image format: `docs/WEBP.md`.

## Ground types (8)

`saturated_grass`, `regular_snow`, `lightdark_dirt`, `stone_mountain`,
`black_mountain`, `clear_water`, `light_sand`, `crystal_ice` — deliberately
specific ids, **not** generic "grass", so `dry_grass`, `jungle_grass`, … can be
added later without anyone owning "the one and only grass". List lives in
`config/tiles2.json:ground_types`.

## House format (every tile)

| setting | value |
|---|---|
| Endpoint | **`/v2/create-tiles-pro`** (16-tile sheets; visible in the pixellab.ai/maps UI) |
| Tile size | **64×64 px** (elevation props: 64×128 canvas) |
| Tile type | **isometric**, view **high top-down**, angle **28.0°** |
| Depth ratio | **0.50** (ground; elevation uses 0.0 — see `docs/ELEVATION.md`) |
| Flat top | **2 px (classic)** |

**Outlines:** `create-tiles-pro` bakes a dark edge outline into this library's
art. Don't chase "lineless" in the prompt — it can't be achieved that way and
only degrades the art. Interior edge lines are accepted as part of the look;
post-process softens the rest (below). (PixelLab has since added
`outline_mode: "segmentation"` — that is Tiles 3.0's reason to regenerate
rather than reprocess; it cannot help art whose outline is already baked in.)

**A sheet** = one `create-tiles-pro` request (~16 tiles) = one PixelLab item —
so the deletable/regenerable unit is a whole **sheet**, never a single tile.

## Folder layout (per ground type `<gid>`)

```
tiles2/<gid>/
  metadata.json                  type meta + harmonize_target (ref_sprite is legacy, always null)
  raw/<sheet>/                   raw download — SOURCE OF TRUTH, never edited
    tile_NN.webp … request.json  (exact prompt + settings + kind: base|transition|elevation)
  base/<sheet>/                  processed ground tiles + metadata.json
  base_x_2 … base_x_5/<sheet>/   processed elevation props (docs/ELEVATION.md)
  transitions/<other>/<sheet>/   processed transition tiles (gid → other)
tiles2/emission.json             night-glow metadata (below)
```

Every destination sheet carries its **own** `metadata.json` (prompt, settings,
seed, per-tile data, how it was processed) — consumers never read `raw/`.
`raw/` is excluded from the deploy image by the root `.dockerignore` but stays
in the repo so processing can be re-tuned and re-run at zero API cost.

## The pipeline (`pipeline/`)

0. **sync** (`sync.py`, runs at loop startup) — PixelLab is the source of
   truth. Every sheet records its PixelLab `tile_id`; delete a tile-set in the
   pixellab.ai/maps UI and sync sees the id 404 and removes that sheet from git
   (raw + processed). The count drops below target, so the loop regenerates.
1. **generate** (`generate.py`) — one request → `raw/<sheet>/` with a
   `request.json` recording prompt, settings, seed, `tile_id`, and kind.
2. **postprocess** (`postprocess.py`, re-runnable from raw, no API) — copies
   each raw sheet into `base/` or `transitions/<other>/` and runs, in order:
   - **`neutralize_outline`** — recolours the dark silhouette rim toward the
     interior colour (kept opaque: no erosion, no seams).
   - **`harmonize`** (`normalize.py`) — pulls each tile's dominant MATERIAL
     colour to the type's target (hue/saturation + mean brightness), hue-band
     targeted so accents (mushroom red, wood brown, flowers, dirt sides)
     survive. Transitions harmonise BOTH materials. **Light sources are spared**
     (`light_source_margin` — the harmonizer must not recolour fire).
     The target: `config.postprocess.palette[gid]` **overrides** auto-detection
     — the whole tileset is re-tinted to the game's HUD palette (grass + dirt
     are the maintainer's exact colours; black_mountain is neutral near-black
     grey `[44,44,45]`, not `#000000`) — else auto-detected from the earliest
     base sheet (or earliest elevation sheet for a base-less type). Recorded as
     `harmonize_target` in the type's `metadata.json`.
   - **`fade_outline`** — reduces the alpha of near-black silhouette-rim +
     thin frame lines (run ≥ `run_min`, thickness ≤ `thick_max`); compact dark
     art (rocks, trunks) spared; `protect_dark_material` keeps black_mountain
     from dissolving.
   - **`clean_top_rim`** — kills the faint dark DOT at every diamond vertex
     (rims converge where four diamonds meet). Threshold is RELATIVE to
     material brightness (`value*factor`) because the rim is only ~30 lum below
     the interior — absolute-dark steps miss it. Top diamond + silhouette band
     only; black_mountain skipped.
   - **`gap_close`** — **THE fix for the in-game grid/seam.** The seam is NOT
     a dark outline on the tiles: it is the dark BACKGROUND showing through
     1–2 px antialiased gaps along every diamond edge (verified: seam pixels ==
     background luminance; a magenta background bled magenta). Hardens the
     silhouette (alpha>16 → opaque) and grows it 2 px outward with
     neighbour-average colour so diamonds overlap and no void shows. Runs LAST
     (fade_outline would otherwise reopen the gap); floor tiles only —
     elevation sprites keep their true silhouette.
   - REJECTED: **`deseam`** stays `enabled:false` — it mis-diagnosed the seam
     as a dark outline and had ~no in-game effect; superseded by `gap_close`.
   - Also computes the per-tile `edges`/`composition` metadata — a tile is not
     "done" until it exists (`metadata_complete: true`); see `docs/METADATA.md`.
3. **loop** (`loop.py`) — resumable, filesystem-driven; completes **one type
   fully before the next**: its 5 base sheets (`base_sheets_per_type`), then a
   transition to every EARLIER type. Generates, processes, commits, pushes.
   Budget-guarded (`config.budget`: proceed only above 500 subscription
   generations or ≥ $1 credits). Not scheduled — run manually.
4. **elevation** (`elevation.py`) — separate slot-filling loop for
   `base_x_2…5` props; see `docs/ELEVATION.md`.
5. **emission** (`emission.py`) — rebuilds `tiles2/emission.json`
   (`tiles2-emission@1`), the night-glow metadata games2 consumes: `materials`
   (curated per-material glow, `null` = non-emitter) + `sources`
   (auto-extracted per-tile glow clusters, keyed by repo-relative path ==
   world.json entry). Regenerate whenever emissive art changes. tiles2 owns
   this data because it owns the art (the game's night shader was keyed to
   v1 names and nothing lit up).
6. **towebp** (`towebp.py`) — container conversions; `common.processed_name()`
   is the ONE place the processed extension is decided. All tile writes go
   through `common.save_tile()` (forces lossless — see `docs/WEBP.md`).

## Transitions — full mesh

**No adjacency list**: map builders must have every border, so each type gets a
transition to EVERY other type — **5 sheets per pair**
(`transition_sheets_per_pair`), each sheet a different border style (soft
ragged / clean sharp / patchy islands / wide gradual / interlocking fingers /
gentle wavy, cycled by sheet index). Stored one direction only — the newer type
owns `<gid>/transitions/<earlier>/`; a pair is skipped if covered either way.

## Running

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...              # gitignored .env

python pipeline/loop.py --dry-run        # show the plan; no API calls
python pipeline/loop.py --once           # next single sheet
python pipeline/loop.py --max-minutes 45 # bounded pass
python pipeline/postprocess.py           # re-run processing from raw (no API)
python pipeline/postprocess.py saturated_grass
```

Config: `config/tiles2.json` (house format, ground types, prompt templates,
targets, budget, every postprocess knob — each knob documented in its
`_comment` there). Any postprocess pass can be toggled off + reprocessed to
revert, because raw is never touched.

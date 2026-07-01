# Maps Spec — Automated Map / Zone Factory

## Goal

An automated, resumable loop that produces good-looking, **game-ready map
zones** via the PixelLab API — the map counterpart to the character factory. Two
zone families:

- **Islands** — a landmass surrounded by water; small (no town) or larger (with a
  small town). Small islands first.
- **Interiors** — a single walled room (cave, house) with furniture and a door.

Each zone is a self-contained **loading zone** under `maps/<zone_id>/`. The
design deliberately stays inside what PixelLab can actually draw.

## Definitions

- **Tileset** — a PixelLab **Wang tileset** (`create-tileset`): two terrain
  levels (`lower`, `upper`) rendered as the 16 corner-combinations that connect
  seamlessly. This is the terrain building block. Shared across zones, generated
  once, stored in `assets/tilesets/<id>/`.
- **Object** — a transparent prop (`map-objects`): tree, house, barrel, bed…
  Shared, generated once, stored in `assets/objects/<id>/`.
- **Zone** — one loading zone: a corner-height layout baked against tilesets +
  objects into `zone.json` + a tile atlas + collision + a rendered preview.

## PixelLab integration (verified against the live API)

- `create-tileset` → `{tileset_id, background_job_id}`; poll the job, then
  `GET /tilesets/{id}` → `tileset.tiles`, each `{name, corners{NW,NE,SW,SE},
  image(base64 png)}`. `transition_size` 0 → 16 tiles; 0.25/0.5/1.0 add a raised
  transition band (more tiles). `view` ∈ {low top-down, high top-down}.
  `tile_size` 16 or 32.
- `map-objects` → `{object_id, background_job_id}`; the job's
  `last_response.image` is a base64 PNG (transparent). ~1 generation.
  NB: `outline` here accepts only `single color outline | selective outline |
  lineless` (no "black" variant) — the shared default `single color outline`
  works for both tilesets and objects.
- `create-image-pixflux` → returns `{image}` synchronously (whole-scene backdrop;
  available in the client, not used by the default plan).
- Auth: `Authorization: Bearer $PIXELLAB_API_KEY`. `GET /balance` →
  `subscription.generations` for budget.

## Scale / proportion criterion

Walkability realism requires one shared pixels-per-tile scale across the repo. A
person is ~**1×2 tiles** (Grave Seasons / Stardew). The characters domain draws
bodies ~67px tall (measured), so maps use **32px tiles** → a character reads at
~2.1 tiles tall; 16px would make it ~4 tiles (as tall as a house) and is
rejected by `pipeline/proportions.py`. Object pixel size is derived as
`tiles × tile_size` from each prop's real footprint, so everything stays in
scale. The loop validates this at startup, normalises every tile to an exact
square, and publishes the tile size on the coordination board so the
characters/objects agents align to it.

## Terrain model — dual-grid Wang

Terrain is defined on tile **corners** (a *dual grid*), not tile centres, because
that is exactly what a Wang tileset indexes.

- A zone has ordered `levels` (e.g. `water, sand, grass, forest`) and `bands` —
  one Wang tileset per **adjacent** level pair (`bands[k]` = level k ↔ k+1).
- `worldgen` builds a `(rows+1)×(cols+1)` grid of terrain level indices and
  **smooths it over all 8 neighbours** so no two corners of any tile cell differ
  by more than one level. That guarantees each cell spans a single band and has a
  matching Wang tile (diagonals included — the reason smoothing is 8-way).
- `zone.py` picks, per cell, the band for its two levels and the tile whose four
  corners match, collects the used tiles into a per-zone atlas, and bakes a
  `tile-index-grid`. One opaque tile per cell → no layer blending, no seams.

This is the standard blob/dual-grid technique and needs nothing PixelLab can't
provide.

## Layout generation (`worldgen.py`, pure, deterministic)

- **island**: radial falloff × value-noise → discrete levels, forced water border
  → smoothed. `land_bias` grows it; more levels → beaches, meadows, forest crown.
- **room**: floor with a wall ring and a carved door gap.
- **scatter**: place props on flat cells whose terrain is in each prop's `on`
  list, with spacing halos so nothing overlaps.
- **place_town**: cluster buildings on the biggest connected grass region.
- **coast_dock_cell**: a beach cell next to open water for a dock exit.

All seeded from the zone `seed`, so a zone regenerates identically.

## Zone assembly & output (`zone.py`)

Produces per zone:
`zone.json` (manifest), `tiles.png` + `tiles.json` (atlas), `objects/*.png`
(sprites used), `preview.png` (rendered picture). Format documented in
`../README.md` (schema `pixel-maps/zone@1`). Includes a **walkable collision
grid** (water/walls + blocking-object footprints) and **exits** linking zones.

## Loop algorithm (`loop.py`)

Each **unit** = one PixelLab op (tileset or object) or one zone assembly (free).
The next unit is derived from the filesystem, so the loop is resumable; each unit
rebuilds the viewer, commits and pushes.

1. Walk `zone_plan` in order (small islands first). For the first un-built zone:
   generate any missing `bands` tilesets, then missing `objects`, then assemble
   the zone.
2. When the plan is exhausted, invent further islands from
   `config.procedural_zones` — endless Phase B, bounded by budget/time/units.

Stops cleanly below `budget.min_generations_remaining`.

## Cost model

Shared assets dominate and are paid once: a tileset ≈ a few generations, an object
≈ 1. A zone reuses them for **zero** generations. So the marginal cost of another
island is ~0 once its biome's tilesets/props exist — cheap to produce a large
world. Exploration keeps islands small and terrain shallow; add bands/props to go
richer.

## Scheduling

A scheduled Routine wakes a session that runs
`python maps/pipeline/loop.py --max-minutes 50`, which advances + pushes, then
exits; the next firing resumes from the filesystem. `.github/workflows/maps.yml`
does the same on a timer and on demand. Without `PIXELLAB_API_KEY` the workflow
no-ops with a warning.

## Boundaries & fleet coordination

Disjoint paths: this domain owns **only** `maps/`. It keeps its own isolated
`pixellab_client.py` (per the repo CLAUDE.md convention). It never touches
`characters/` or `objects/`. Concurrent pushes to `main` rebase cleanly because
the domains edit different files.

Three agents (characters / objects / maps) share one repo, one `main`, and one
PixelLab account, coordinated by [`../../coordination/PROTOCOL.md`](../../coordination/PROTOCOL.md):

- **One writer per file** — this loop writes only `coordination/maps.json` (its
  heartbeat, refreshed each unit via `pipeline/coordination.py`) and reads the
  other domains' status files at startup.
- **Shared budget floor** — `budget.min_generations_remaining` is **2000** (not
  the characters domain's 40) so maps never drains the shared generation pool.
- **Cross-domain requests** — the loop scans other domains' `requests` for
  `"to": "maps"` at startup and answers via its own `notes`.
- **Key contention** — concurrent calls on the one account are absorbed by the
  client's 429/5xx retry-with-backoff.

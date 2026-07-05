# maps2 — worlds for the new game (Map2 agent)

Second-generation world assembler. Consumes **`tiles2/`** (the new tile system
with specifically-named ground types and first-class transitions) and produces
**worlds** under `maps2/worlds/<name>/`. Built to support **several** maps —
test maps for evaluating tiles + (eventually) the one production world.

## Geometry (tiles2)

- top diamond **30px** tall × 64px wide (grid steps DX=32, DY=15)
- one elevation level = **16px** of vertical face
- terraced cliffs are built by stacking a type's `base` tile 16px per level
  (pixel-perfect per `tiles2/docs/ELEVATION.md`)

## Pipeline (`pipeline/`)

- `tiles2lib.py` — loads tiles2; per-type target colour; analyses every
  transition tile from pixels into **composition** (material mix) + **orientation**
  (screen-space direction the split faces). Cached to `config/tiles2_analysis.json`.
- `ringworld.py` — the ring/donut test-map generator + the transition
  **auto-tiler** (one-sided feather: the lower-priority material blends into the
  higher one; per cell we pick the transition tile whose measured composition and
  orientation match the geometry, so borders are seamless and correctly faced).
- `render2.py` — isometric renderer (window / overview / minimap) for the new geometry.
- `build.py` — `python maps2/pipeline/build.py ring_test --n 160 --seed 7`.

## Worlds

- `worlds/ring_test/` — the transition-evaluation donut: `clear_water` centre
  (spawn), 5 pizza slices (saturated_grass, lightdark_dirt, stone_mountain,
  black_mountain, regular_snow), elevation rising outward. See `INSIGHTS.md` for
  what the transitions taught us for the real game.

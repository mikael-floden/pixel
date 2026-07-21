# maps2 — worlds for the new game (Map2 agent)

Second-generation world assembler. Consumes **`tiles2/`** (the new tile system
with specifically-named ground types and first-class transitions) and produces
**worlds** under `maps2/worlds/<name>/`. Built to support **several** maps —
test maps for evaluating tiles + (eventually) the one production world.

## Elevation & occlusion rules — ALWAYS apply when shaping terrain

Read this every time, the same way you always run the transition auto-tiler.

The camera looks from the **south**, so a tile toward the camera (larger `x+y`)
draws **over** whatever is up-screen behind it. If a player stands with **higher
ground on their camera-facing (`+x`/`+y`) side**, that ground swallows their legs —
and its cliff face points *away* from the camera (invisible), so with the **same
material** on both sides it reads as a rendering bug, not a hill. **Never ship
that.** (It's fine where the hill's face IS visible — a rise descending toward the
camera — so the fix is not "change material at every level".)

**The rule, one line:** land elevation must never step **up toward the camera**
with the same material. Equivalently — make terrain **camera-facing**: high
up-screen, sloping **down toward the camera**, so every cliff face is visible.

Consequences to honour:

- **Slopes face the camera.** A rise whose face is visible (it descends toward the
  camera) is fine with one material over a big area. The forbidden case is the
  far/back side of a hill *descending away from the camera*.
- **Up-screen coasts are sheer sea-cliffs, not beaches.** The top of the map drops
  abruptly to water so the player falls off / can't walk behind it (à la Zelda
  *A Link to the Past*'s northern mountains). Beaches live only on the **near
  (camera) shore.** This also limits where walk-behind valleys can occur — which is
  fine, valleys/cliffs are still allowed, just make their faces camera-visible.
- **Change material only across a genuine away-step, and only as a BIG region** —
  the whole far side becomes a different type, **never a 1-cell stripe.** (Usually
  unnecessary: camera-facing terrain + always-different water boundaries cover it.)
- **Fog exception:** a drop of **more than 10 levels** is separated by the game's
  fog, so the same material MAY be reused across it (an alternative to changing
  type — just make sure the z-distance is >10 and let the fog do the work).

Enforce it in code (`pipeline/autotile.py`):

- **`camera_monotone(level, mat)`** — reshapes land so no cell is lower than its
  toward-camera neighbours: every slope becomes camera-facing and every up-screen
  coast becomes a sea-cliff. Run it **after `flatten_shores`** (which beaches all
  coasts) so only the near-shore beaches survive.
- **`occlusion_violations(mat, level)`** — returns every remaining hidden
  same-material lip (drops >10 ignored as fog-safe). A generator must print/assert
  this is **empty**. `pipeline/lostworld.py` (`demo_lost`) is the reference.

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

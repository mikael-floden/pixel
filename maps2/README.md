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
  this is **empty**. `pipeline/islandworld.py` (`the_island`) is the reference.
  (`demo_lost` is the *older* grass island, kept as-is and NOT under this rule —
  don't use it as the pattern.)

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
- `worlds/the_island/` (`islandworld.py`) — the WIP production island: organic
  warped coastline, a camera-facing staircase of gated cliffs, a jagged multi-peak
  mountain (max level 30), a gorge with connected stone bridges. The reference for
  the elevation/occlusion rules above.
- `worlds/the_island2/` (`islandworld2.py`) — a ~2×-bigger island that pairs
  **two worlds**: an antitone **mountain** (upper) with a new *A Link to the Past*-style
  relief **maze** (lower). The maze can't be antitone (a strictly-antitone field only
  makes one connected lowest sheet, so it could never separate two equal-level floors
  laterally), so it uses genuine relief kept occlusion-legal by the **wall-material
  rule**: any same-material toward-camera up-step has its higher rim recoloured to a wall
  material (stone/obsidian) via `_wall_rim` + an iterated, neighbour-aware, all-zones
  `mat`-only `_lip_cover` (a Δ>10 step is fog-exempt, so tier-12 keeps its grass top).
  Design details (all four hard-asserted):
  - **Mountain** is TERRACED onto flat benches `{16,20,24,28,32}` (Δ4 cliffs, `camera_monotone`
    masked to it), with varied peak heights + a carved valley/tarn so it climbs in steps and
    undulates up *and* down (mostly up); rock with snowy/ice/obsidian peaks. Floor 16 sits a
    gated Δ4 above the maze cap 12.
  - **Maze** tiers are `{0,4,12}` — deltas mostly Δ4, sometimes Δ8, rarely Δ12 (dramatic cliffs,
    no timid Δ2). Winding cliff/water corridors, a river + bridges.
  - **Ascents** are Trollstigen **switchbacks** (`_carve_switchback`): Z-roads of flat dirt
    benches joined by up-screen risers (climb only rises away from camera → antitone/legal),
    preferred by `_merge_ramp` for Δ≥4 cliffs, falling back to the straight spur where a Z
    won't fit (so the connectivity guarantee holds).
  - **Material policy — dirt=roads, rock=stairs**: cliff-climbing ramps/switchbacks are
    `stone_mountain` (`STAIR_MAT`, tracked in `self._ascent`); flat paths are `lightdark_dirt`.
    No dirt staircases, no dirt borders/collars.
  - **8-direction dirt ROADS** (`_dirt_roads`): an organic meandering, branching network that
    runs in all 8 SCREEN directions — the router (`_road_graph_bfs`) adds grid-diagonal moves
    (which render screen-vertical/horizontal) on flat Δ0 land, each gated by a same-level
    **elbow** cell so the painted road stays 4-connected-walkable; the √2 diagonal weight beats
    the 2.0 cardinal zigzag. Held a **margin** off beach/water and the mountain foot and biased
    to corridor **centres** via a cached `_road_cost_field` (distance fields); trunk
    spawn→summit + landmark/stair-foot spurs fork at Y-junctions. Mat-only; grass→dirt only.
  - **Full-height rock Z-stairs** (`_mountain_stairs`/`_climb_corridor`/`_next_bench_step`):
    a couple of tidy stone Trollstigen ribbons zigzag the whole massif (16→40); the rest of
    the foot stays a sheer cliff; `_merge_ramp` uses only clean rock connectors otherwise.
  - **Multi-level water** (`_ponds`/`_tarn`/`_mtn_gorge`): besides the ocean, small **flush**
    lakes at maze tiers `{4,12}` and mountain benches `{20,24}`, a flush alpine tarn, and an
    internal mountain **gorge** (descend-then-climb) — all transactional so they never seal a
    region.
  - **Spiky massif**: benches `{16,20,24,28,32,36,40}`, ~10 sharp varied-height peaks with deep
    saddles + camera-fanning grooves → a jagged skyline (max level 40), not a smooth pyramid.
  - **Bigger beaches** + a wide **ocean margin** (`M=24`, `n=248`; island inset via `_coastline`,
    `nd` stays 200). `build()` asserts no land on the border. NOTE: a finite frame only pushes
    the edge out of view; to *never* show an "end of world" the **game client** must clamp the
    camera to world bounds or fill out-of-bounds with `clear_water` — that's the engine's job,
    not the generator's.

  Reachability is **prop-aware** (props set `collision=1`). `demo_lost` and `the_island`
  are preserved unchanged.

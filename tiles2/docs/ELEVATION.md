# Elevation tiles (base_x_2 / base_x_3 / base_x_4)

Taller variants of a terrain that **stack pixel-perfectly** on the normal
(base_x_1) tile. They live as siblings of a terrain's `base/` folder:

```
saturated_grass/
  base/        base_x_1  (height 1, face 16px)
  base_x_2/    height 2  (face 32px)
  base_x_3/    height 3  (face 48px)
  base_x_4/    height 4  (face 64px)
  raw/         source sheets (kind=elevation, height=base_x_N)
  transitions/
```

## Why they stack pixel-perfectly

Every tile — x1 through x4 — is generated with the **identical diamond top**:
`tile_size 64`, `tile_view_angle 28`, `tile_flat_top_px 2`. Measured, that top is
**30px tall / 64px wide on every setting** (verified across depths and canvas
sizes). Because the top never moves, the walkable surface of a base_x_N tile lands
in exactly the same place as N stacked base_x_1 tiles — only the side **face**
grows. One "level" = base_x_1's 16px face, so:

| height   | levels | target face | tile_size | tile_height | depth_ratio | measured face |
|----------|:------:|:-----------:|:---------:|:-----------:|:-----------:|:-------------:|
| base_x_1 |   1    |    16px     |    64     |   — (64)    |   0.50      | 16 (exact)    |
| base_x_2 |   2    |    32px     |    64     |   — (64)    |   **0.985** | 32 (median)   |
| base_x_3 |   3    |    48px     |    64     |   **128**   | **0.2423**  | 48 (median)   |
| base_x_4 |   4    |    64px     |    64     |   **128**   | **0.4885**  | 64 (tight)    |

## How the depths were calibrated

`create-tiles-pro` face height is linear in `depth_ratio` at a fixed canvas:

* **64×64** canvas: `face ≈ 34·depth − 1` → depth 0.50 gives 16 (=base_x_1),
  depth 0.985 gives 32. (The generator quantises to even values near the top, so
  32 is as centred as it gets; depth 1.0 overshoots to 33.)
* **64×128** canvas: `face = 65·depth + 32.25` (measured at depths 0.35/0.55/0.75,
  R²≈1). The +32px intercept is a real floor the taller canvas reserves — which is
  why x3/x4 use depths *below* 0.5. Solving: face 48 → 0.2423, face 64 → 0.4885.

Both fits were confirmed by generating grass tiles at the solved depths and
re-measuring (x3 → 48 median, x4 → 64 tight). The diamond top stayed 30px in every
case, which is the invariant that makes stacking exact.

Recalibrate with `scratchpad` scripts `calib_elev.py` (fit) / `verify_elev.py`
(confirm a single depth). Face is measured consistently with
`tilemeta.diamond_corners`: `diamond_h = 2·(y_Wcorner − y_apex)`,
`face = y_bottom − (y_apex + diamond_h)`.

## Content, colour, and re-rolls

* **Decorations** — each `(terrain, height)` fills a fixed list of decoration
  slots (`config.elevation.terrains[].decorations[height]`), one sheet per slot:
  grass gets trees/bushes/mushrooms/boulders, stone gets spires/fortress/cliffs,
  crystal_ice gets crystal spires, snow gets peaks/drifts.
* **Harmonisation** — each tile is pulled toward its terrain's own palette
  (`terrain.harmonize_refs`): greens → grass, greys → stone, blues → ice. This is
  hue-band targeted, so distinct accents (mushroom red, wood brown) are left alone
  and the block blends into scenes built from the matching ground tiles. A ref
  with no base sheet yet (no colour target) is skipped; re-run `--reprocess` once
  it exists (raw is always kept, so this is free).
* **Delete-in-UI → re-roll** — `sync()` runs at the start of every
  `elevation.py` run and removes any sheet whose PixelLab `tile_id` 404s (raw +
  the processed `base_x_N/` copy), reopening that decoration slot. The next run
  regenerates *the same decoration* with a **fresh seed** — a per-slot attempt
  counter in `elevation_state.json` bumps each try — so you get a new attempt at
  the tile you didn't like, not a duplicate of a different one.

## Running

```
python tiles2/pipeline/elevation.py --dry-run     # show slot fill state
python tiles2/pipeline/elevation.py               # sync, then fill open slots + push
python tiles2/pipeline/elevation.py --reprocess   # re-harmonise from raw (no API calls)
```

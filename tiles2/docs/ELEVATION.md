# Elevation tiles (base_x_2 … base_x_5)

Height-tiered **free-standing props** of a terrain — statues, dead trees,
giant mushrooms, runestones, cairns, crystals, snowmen … — stored as siblings
of the terrain's `base/` folder:

```
saturated_grass/
  base/        base_x_1 — the ground tile (64×64, depth 0.50, 16px face)
  base_x_2/    "small" props        ┐ this module: all 64×128 canvas,
  base_x_3/    "medium-sized" props │ depth_ratio 0.0, transparent
  base_x_4/    "large" props        │ background
  base_x_5/    "huge towering" props┘
  raw/         source sheets (kind=elevation, height=base_x_N)
```

## The current law: objects stand FREE (maintainer decision)

An elevation tile is a single object **standing free in empty space, resting
on a small low patch of its terrain** — the object IS the sprite. The prompt
(`config.elevation.template`) hard-forbids boxes, cubes, pedestals, frames,
wireframes and black borders ("kill the cube/box"): the earlier
calibrated-terrain-block approach put every object on a raised cube and was
rejected + regenerated. `depth_ratio` is **0.0 for every height**; the
`height_word` tier (small → huge towering) and the per-tier object pools carry
the scale. All heights share the 64×128 canvas so tall objects never clip;
only base_x_1 ground stays 64×64.

- **`levels`** (2–5) is the intended in-world height in ground-levels
  (1 level = base_x_1's 16px face); it sizes the object, not a wall face.
- Elevation sprites keep their **true silhouette** — the `gap_close`
  postprocess pass is floor-tiles-only and must never harden these.

## Content, colour, re-rolls

- **Variety** — a sheet is NOT 16 clones. Each sheet numbers a seed-shuffled
  subset (`objects_per_sheet`, config: 10) of that `(terrain, height)` pool in
  `config/elevation_objects.json`, so one call returns many *different*
  objects. **3 sheets** per `(terrain, height)` (`target_sheets_per_elev`);
  8 terrains × 4 heights. Pools are meant to grow — add ideas freely.
- **Harmonisation** — each tile is pulled toward its terrain's palette
  (`terrain.harmonize_refs`); hue-band targeted, so distinct accents (mushroom
  red, wood brown) survive. A ref with no colour target yet is skipped —
  re-run `--reprocess` once it exists (raw is always kept, so this is free).
- **Delete-in-UI → re-roll** — `sync()` runs at the start of every
  `elevation.py` run and removes any sheet whose PixelLab `tile_id` 404s
  (raw + processed), reopening the slot. The next run fills it with a **fresh
  seed** (per-slot attempt counter in `elevation_state.json`) — a brand-new
  shuffled object set, not the same tiles again.

## Running

```
python tiles2/pipeline/elevation.py --dry-run     # show slot fill state
python tiles2/pipeline/elevation.py               # sync, then fill open slots + push
python tiles2/pipeline/elevation.py --reprocess   # re-harmonise from raw (no API)
```

## Measured geometry (keep — needed if calibrated block faces ever return)

The `create-tiles-pro` **diamond top is 30px tall × 64px wide at every
setting** (verified across depths and canvas sizes) — the invariant that makes
any tile land on the same grid cell. Face height is **linear in
`depth_ratio`** at a fixed canvas:

- **64×64**: `face ≈ 34·depth − 1` → depth 0.50 gives 16px (=base_x_1);
  depth 0.985 gives 32 (generator quantises near the top; 1.0 overshoots to 33).
- **64×128**: `face ≈ 65·depth + 32` (high range 0.35–0.75; ≈59·depth+33 below
  0.2). The +32px intercept is a real **floor**: at depth 0.0 the face is
  already ~33px, so a 16 or 32px face is impossible on this canvas.

The retired calibrated-block depths, confirmed by regeneration: face 48 →
0.2423, face 64 → 0.4885, face 80 → 0.7346. Measure faces with
`pipeline/tilemeta.py:diamond_corners`: `diamond_h = 2·(y_Wcorner − y_apex)`,
`face = y_bottom − (y_apex + diamond_h)`.

# Pixel Tiles

Automated generator of **isometric terrain tiles** for the game — the tile
library the **Maps agent** assembles into worlds. Part of the multi-domain
`pixel` repo (alongside `characters/` and `objects/`).

Every tile shares one fixed base format (PixelLab `create-tiles-pro`):

| Property | Value |
|---|---|
| Shape | **isometric** |
| Tile footprint | **64 px wide** (exact) |
| View angle | **28°** |
| Flat-top | 4 px |

Tiles are **focused**: each category is on-theme only (a `snow` set is all snow) —
never a mix of unrelated materials in one sprite.

---

## Tile types (height profiles)

The world is multi-level, so tiles come in four **height profiles**. They all use
the same 64-wide footprint (so they snap to the same iso grid) but differ in image
height + thickness, giving different vertical **face** heights for elevation:

| profile | image | thickness | face px | layers | use |
|---|---|---|---|---|---|
| `flat`   | 64×64  | 50%  | ~19px  | **0.5** | ground plane |
| `raised` | 64×64  | 100% | ~38px  | **1**   | 1-level steps, low walls, fences, ramps |
| `cliff`  | 64×128 | 75%  | ~76px  | **2**   | 2-level cliffs / banks |
| `tall`   | 64×128 | 100% | ~102px | **~2.7**| tall walls, towers, peaks |

Each tile set's `tiles.json` records its `profile`, and per-set measured
`stacking` numbers (see below) — always trust those, not this table, for exact px.

## How stacking / elevation works (the important part)

Placement on the isometric grid, for tile cell `(col, row)`:

```
screen_x = origin_x + (col - row) * grid_dx        # grid_dx = 32
screen_y = origin_y + (col + row) * grid_dy        # grid_dy = diamond_top_height/2 (~13)
draw back-to-front by increasing (col + row)        # so tiles overlap correctly
```

**Elevation:** one level = **`one_layer_px` = 38px** (a 64×64 @ 100% tile's face).
To place a tile `N` levels up, **subtract `N * 38` from its `screen_y`** and draw
higher levels after lower ones. The verified geometry:

```
face_px = depth_ratio * (tile_height - 26)     # 26 = diamond top height
```

- A **cliff/wall** tile's own `face_height_px` (in metadata) is how much vertical
  drop it covers — e.g. a `cliff` set (~76px = 2 layers) is the face for a plateau
  raised 2 levels. Place it at the plateau edge; its top aligns with the raised
  ground, its bottom with the lower ground.
- To stack blocks flush, offset the upper tile up by its own `face_height_px`.
- For clean multi-level terrain, keep elevation in whole `one_layer_px` steps and
  use `raised`(1) / `cliff`(2) tiles for the faces. `tall` (~2.7) is for scenery
  (towers, peaks) rather than exact-step terrain.

> Note: a 64×128 image caps the face at ~102px (128 − 26 diamond), so **no tile
> exceeds ~2.7 layers**; taller cliffs are built by stacking levels, not by one
> giant tile.

## Metadata (`tiles/<category>/tiles.json`, schema `pixel-tiles/set@1`)

```jsonc
{
  "category": "cliff_grass",
  "profile": "cliff",                 // flat | raised | cliff | tall
  "kind": "elevation",                // ground | elevation
  "description": "isometric grassy cliff tiles, two-level ...",  // exact prompt
  "tile_type": "isometric",
  "tile_size": 64, "view_angle": 28, "depth_ratio": 0.75,
  "tile_height": 128, "flat_top_px": 4,
  "geometry": { "grid_dx": 32, "grid_dy": 13, "diamond_top_height": 26,
                "level_height": 76, "note": "…placement math…" },
  "stacking": { "face_height_px": 76, "one_layer_px": 38, "layers": 2.0,
                "diamond_top_height_px": 26, "grid_dx": 32, "grid_dy": 13,
                "formula": "…" },
  "count": 16,
  "tiles": [ { "index": 0, "file": "tile_00.png", "width": 64, "height": 128 }, … ],
  "preview": "preview.png",
  "generated_at": "…UTC…",
  "provenance": { "tool": "pixellab", "endpoint": "/create-tiles-pro",
                  "seed": 12345, "request": { …exact params… } }
}
```

So for any tile the Maps agent knows: **what it is** (`category`, `description`,
`profile`, `kind`), **how it was generated** (`provenance.request`, `seed`), and
**how to place/stack it** (`geometry` + `stacking`, in exact pixels).

## Layout

```
tiles/
  README.md · config/tiles.json · pipeline/
  <category>/  tile_00.png … tile_NN.png · tiles.json · preview.png
```
A **category** = any `tiles/` subfolder with a `tiles.json`.

## Running the loop

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...          # gitignored .env
python pipeline/loop.py --once       # generate the next un-made category
python pipeline/loop.py --max-minutes 50
```

Each unit = one `create-tiles-pro` call (~16 tiles, **~20 generations**),
downloaded to `tiles/<category>/`, then committed and pushed. Resumable,
budget-aware; keeps inventing focused categories (`config.procedural`) to hold the
~40/20/20/20 profile mix and grow the library forever.

## Coordination

Shared repo/`main`/PixelLab account (see
[`../coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)). The tiles agent
writes only `coordination/tiles.json` and keeps a budget floor.

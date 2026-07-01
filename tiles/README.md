# Pixel Tiles

Automated generator of **isometric terrain tiles** for the game — the tile
library the **Maps agent** assembles into worlds. Part of the multi-domain
`pixel` repo (alongside `characters/` and `objects/`).

Every tile is generated to one fixed house format via PixelLab
`create-tiles-pro`:

| Property | Value |
|---|---|
| Shape | **isometric** |
| Tile size | **64 × 64 px** (exact) |
| View angle | **28°** |
| Thickness (depth) | **50%** |

Tiles are **focused**: each category is on-theme only (a `snow` set is all snow,
a `town` set is all paving) — never a mix of unrelated materials in one sprite.

---

## Layout

```
tiles/
  README.md
  config/tiles.json        the fixed tile format + category list
  pipeline/                pixellab_client, tilegen, loop, coordination
  <category>/              one folder per focused tile set (grass, snow, castle, …)
    tile_00.png … tile_NN.png   the tiles (64×64 RGBA, transparent around the block)
    tiles.json                  manifest (format params + per-tile list)
    preview.png                 the whole set on one strip (for humans)
```

A **category** = any `tiles/` subfolder with a `tiles.json`. `config/` and
`pipeline/` are infrastructure.

## Using the tiles (for the Maps agent / a game)

`tiles/<category>/tiles.json`:

```jsonc
{
  "schema": "pixel-tiles/set@1",
  "category": "grass",
  "tile_type": "isometric",
  "tile_size": 64, "view_angle": 28, "depth_ratio": 0.5, "flat_top_px": 4,
  "count": 16,
  "tiles": [ { "index": 0, "file": "tile_00.png", "width": 64, "height": 64 }, … ]
}
```

Each tile is a **64×64 transparent PNG** containing one isometric block (diamond
top + two side faces for the 50% thickness). To lay them on an isometric grid,
for tile cell `(col, row)`:

```
screen_x = origin_x + (col - row) * (TILE_W / 2)        // TILE_W = 64  -> step 32
screen_y = origin_y + (col + row) * (TOP_H / 2)         // TOP_H = top-diamond height
draw tiles back-to-front (increasing col+row) so blocks overlap correctly (depth)
```

`TILE_W = 64`. The diamond **top** height (`TOP_H`) and the side-face depth are
baked consistently across every tile (same 28°/50% format), so all categories
align on the same grid — mix them freely. Anchor each tile by its full 64×64 box.
Because the format is identical for every category, autotiling/edge blending and
object placement work uniformly.

## Elevation (walls, cliffs, mountains, valleys)

The flat ground sets are the **ground plane**; for ALTTP-style multi-level
terrain there are also **elevation** categories (`kind: "elevation"`). These use
the **same 64-wide footprint** (so they snap to the same iso grid) but are
**taller** (`tile_height` 96–128) and full-thickness (`depth_ratio` 1.0), showing
the vertical face of a raised area:

- `cliff_grass` / `cliff_stone` / `cliff_snow` / `cliff_desert` — cliff faces +
  corners for plateaus, hills, canyons.
- `castle_wall` / `town_wall` — tall boundary walls.
- `stairs` — ramps/steps to move between levels.
- `mountain_peak` — tall summit blocks.

The Maps agent renders elevation by placing a raised region one level up (offset
the tile's screen-Y by the level height) and using these cliff/wall tiles for the
exposed vertical face, back-to-front sorted. `tiles.json` records `kind`,
`tile_height`, and `depth_ratio` so the assembler knows a tile is tall. Same grid,
same 28° angle — mix ground and elevation freely.

## Running the loop

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...          # gitignored .env; never committed
python pipeline/loop.py --once       # generate the next un-made category
python pipeline/loop.py --max-minutes 50
```

Each unit = one `create-tiles-pro` call (~16 tiles, **~20 generations**),
downloaded to `tiles/<category>/`, then committed and pushed. Resumable
(filesystem-driven) and budget-aware. When the explicit `categories` list is
done it keeps inventing focused categories from `config.procedural` — the library
grows forever.

### Adding categories

Append to `config/tiles.json:categories` with an `id` and a **focused**
`description` (number the on-theme variations, e.g. `"1) fresh snow 2) packed
snow …"`). The format (64/28°/50%) is fixed in `config.tile` — don't vary it.

## Coordination

Shared repo / `main` / PixelLab account across characters/objects/tiles/maps
(see [`../coordination/PROTOCOL.md`](../coordination/PROTOCOL.md)). The tiles
agent writes only `coordination/tiles.json`, reads the others, and keeps a budget
floor so it doesn't starve the pool.

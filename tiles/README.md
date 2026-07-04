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
height + thickness, giving different vertical **face** heights for elevation.

**One elevation level = 19px** (the flat ground tile's own side-face, measured
exact). Everything is expressed in that unit:

| profile | image | thickness | face px | levels | align | use |
|---|---|---|---|---|---|---|
| `flat`   | 64×64  | 50%  | **19px**  | **1** | **exact** | ground plane / base slab |
| `raised` | 64×64  | 100% | **38px**  | **2** | **exact** | 1–2-level steps, low walls, fences, ramps |
| `cliff`  | 64×128 | 75%  | ~84px | ~4 | *scenery* | tall cliff / bank faces |
| `tall`   | 64×128 | 100% | ~100px | ~5 | *scenery* | tall walls, towers, peaks, trees |

**Only the 64×64 tiles (`flat`, `raised`) land on exact whole levels** — they're
the building blocks for terraced terrain. The 64×128 tiles (`cliff`, `tall`) are
**scenery**: their faces are *not* exact level multiples, so don't stack them as
precise steps — place them by their measured `base_y` anchor (below). Build any
exact N-level cliff by stacking 64×64 tiles (`raised`=2 + `flat`=1 …) instead.

Each tile set's `tiles.json` records its `profile`, `align`, and per-set measured
`stacking` numbers (see below) — always trust those, not this table, for exact px.

## How stacking / elevation works (the important part)

Placement on the isometric grid, for tile cell `(col, row)`:

```
screen_x = origin_x + (col - row) * grid_dx        # grid_dx = 32
screen_y = origin_y + (col + row) * grid_dy        # grid_dy = diamond_top_height/2 (~13)
draw back-to-front by increasing (col + row)        # so tiles overlap correctly
```

**Elevation:** one level = **`one_layer_px` = 19px** (a 64×64 @ 50% flat tile's
face — measured exact). To place a tile `N` levels up, **subtract `N * 19` from its
`screen_y`** and draw higher levels after lower ones.

- **Exact terracing uses only the 64×64 tiles.** `flat` = 1 level, `raised` = 2
  levels — both measured on the fixed 64-box, so they stack into any whole height
  with no drift. Want a 5-level cliff? Stack `raised`(2)+`raised`(2)+`flat`(1).
- **`cliff` / `tall` are scenery**, not exact steps. Their `stacking.layers` is
  fractional (~4.4, ~5.3) because the 64×128 box renders the face slightly off a
  whole multiple. Place them by the **bottom anchor** (next section), letting the
  front tiles clip any overhang — never rely on their face for an exact level.

### Bottom-anchoring (no per-tile correction needed)

Thicker tiles sit their footprint lower in the image, so you can't paste every
tile at the same top offset. Instead **anchor by `base_y`** — the image row of the
footprint's front tip, which is the tile's actual ground-contact point and is
recorded per set (`stacking.base_y` / `geometry.base_y`) *and per tile*
(`tiles[i].base_y`). Paste each tile so its `base_y` lands on the cell's front-tip
screen row; tiles of any thickness then line up automatically. Each `tiles[i]`
entry also carries `apex_y` (top of the sprite) and `face_px` (its own face
height), so no pixel-hunting is required.

> A 64×128 image caps the face near ~100px, so **no single tile exceeds ~5
> levels**; taller cliffs are built by stacking 64×64 levels, not one giant tile.

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
                "level_height": 84, "apex_y": 5, "base_y": 119,
                "image_height": 128, "note": "…placement math…" },
  "stacking": { "face_height_px": 84, "one_layer_px": 19, "layers": 4.42,
                "levels": 4, "align": "scenery", "apex_y": 5, "base_y": 119,
                "image_height": 128, "diamond_top_height_px": 26,
                "grid_dx": 32, "grid_dy": 13, "formula": "…" },
  "count": 16,
  "tiles": [ { "index": 0, "file": "tile_00.png", "width": 64, "height": 128,
               "apex_y": 5, "base_y": 119, "face_px": 84 }, … ],
  "preview": "preview.png",
  "generated_at": "…UTC…",
  "provenance": { "tool": "pixellab", "endpoint": "/create-tiles-pro",
                  "seed": 12345, "request": { …exact params… } }
}
```

So for any tile the Maps agent knows: **what it is** (`category`, `description`,
`profile`, `kind`), **how it was generated** (`provenance.request`, `seed`), and
**how to place/stack it** (`geometry` + `stacking`, in exact pixels).

## Self-emission registry (`tiles/emission.json`, schema `tile-emission@2`)

Some tiles GLOW with their own light (lava, magic crystals, shining gold…).
`tiles/emission.json` is the registry the games consume for night lighting
(nangijala: a self-glow floor on the tile's own pixels, shadow-free light
pools, and a localized halo per glowing pixel cluster — Sea of Stars-style
environment lights).

**Every category must have an entry — `null` means "audited, does not glow".**
That null is the audit trail: it proves someone looked at the art. Most tiles
do NOT glow; emission is a spice, not a default.

```jsonc
"lava": {
  "color": [1.0, 0.35, 0.13],   // 0..1 RGB, measured from the art
  "strength": 0.9,              // 0..1 — intensity of the pool around it
  "radius": 3.5,                // pool size in grid cells
  "anim": "flicker",            // static | flicker | pulse
  "self": 0.85,                 // 0..1 — how much its OWN pixels resist night
  "variants": 16,               // (generated) total tile_NN count
  "sources": {                  // (generated) per-pixel glow sources
    "0": [                      //   variant index (tile_00)
      { "x": 31.2, "y": 20.4,   //   cluster centroid, image px
        "r": 4.1,               //   cluster radius, px
        "color": [1, 0.42, 0.1],//   the cluster's OWN colour
        "s": 0.8,               //   strength 0..1
        "dir": "up" }           //   up | sw (left face) | se (right face)
    ]
  }
},
"meadow": null                   // audited: does not glow
```

`anim` by material: fire/lava **flicker**, magic (crystals, mushrooms)
**pulse**, steady shine (gold, ice) **static**.

The `sources`/`variants` blocks are **GENERATED** — run
`node games/nangijala/scripts/analyze-emission.mjs` after art changes; it
detects the exact glowing pixel clusters per variant and their facing
(top-diamond pixels glow up, face pixels glow toward their side). Hand-edit
only the category-level fields. Inspect any tile in the game's emission demo
world (`/#emission`, or press [0] in game): every glowing variant on a
numbered station.

**TILES AGENT: when generating a NEW category, add its entry here in the same
commit** (usually `null` — the pipeline's `register_emission` does this
automatically), and if you mark one emissive, run the analyzer above. The
game's CI gate (`games/nangijala/scripts/check-surfaces.mjs`, run by its
`npm test`) FAILS when a world-used category is missing from the registry and
shape-checks every non-null entry including its sources.

## Layout

```
tiles/
  README.md · emission.json · config/tiles.json · pipeline/
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

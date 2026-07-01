# Pixel Maps

Automated, PixelLab-backed **map** generator — the map counterpart to the
character factory in [`../characters/`](../characters/). It produces **islands**
(overworld maps) and **indoor zones** (caves, houses), each as a self-contained
**loading zone** you can drop into a top-down 2D game.

- **Islands** — a landmass surrounded by water. Small ones have no settlement;
  larger ones can carry a small town.
- **Interiors** — a single room (cave, cabin) with walls, furniture and a door.

Everything is drawn by [PixelLab](https://pixellab.ai) using features it actually
supports (Wang **tilesets** for terrain, **map objects** for props). The loop
never asks PixelLab for something it can't make — layout, collision and
composition are done locally from those pieces.

---

## Layout

```
maps/
  README.md                 ← you are here
  spec/MAPS_SPEC.md         design + loop algorithm
  config/maps.json          tileset profiles, object pool, zone plan
  pipeline/                 the loop (pixellab_client, assets, worldgen, layouts, zone, loop, viewer_build)
  assets/                   SHARED art, generated at most once, reused by every zone
    tilesets/<id>/          a Wang tileset  (tileset.json + tiles/*.png)
    objects/<id>/           a prop          (object.json + object.png)
  index.html                phone-friendly zone viewer
  viewer_data.json          generated index for the viewer
  <zone_id>/                ← EACH such subfolder is one loading zone (has a zone.json)
```

> **A zone is any top-level `maps/` subfolder that contains a `zone.json`.**
> `pipeline/`, `config/`, `spec/` and `assets/` are infrastructure (no
> `zone.json`) — everything else is a playable loading zone.

Each zone folder is self-contained: it ships its own terrain atlas and the object
sprites it uses, so you can load a zone without reading anything outside its
folder (`assets/` is kept only as the shared master / provenance).

```
maps/isle_of_dawn/
  zone.json        the manifest (everything below is referenced from here)
  tiles.png        terrain tile atlas for THIS zone
  tiles.json       atlas index → {tileset, tile, corners, position}
  objects/*.png    the prop sprites this zone places
  preview.png      a full rendered picture of the zone (for humans / GitHub)
```

---

## The map data format (`zone.json`)

`zone.json` is the single source of truth for a zone. Schema id
`pixel-maps/zone@1`. Fields:

| field | meaning |
|---|---|
| `id`, `title`, `description` | identity |
| `kind` | `island` or `interior` |
| `archetype` | `small_island`, `island_town`, `cave`, `house`, … |
| `view` | PixelLab camera, e.g. `high top-down` |
| `tile_size` | pixels per tile (e.g. `16`) |
| `grid` | `{width, height}` in **tiles** |
| `pixel_size` | `{width, height}` in pixels (`grid × tile_size`) |
| `levels` | ordered terrain names, low→high (e.g. `["water","sand","grass"]`) |
| `bands` | tileset ids; `bands[k]` draws the boundary between `levels[k]` and `levels[k+1]` |
| `layers` | render layers (currently one `terrain` tile layer) |
| `tileset` | the per-zone atlas descriptor (`tiles.png` / `tiles.json`) |
| `corner_heights` | the dual-grid source data (terrain level per tile *corner*) |
| `objects` | placed props |
| `collision` | walkable grid |
| `exits` | doors/docks linking to other zones |
| `preview` / `preview_scale` | rendered picture + its upscale factor |
| `provenance` | which PixelLab tilesets produced this |

### Terrain layer

```jsonc
"layers": [{
  "name": "terrain", "type": "tilelayer",
  "width": 22, "height": 18,
  "encoding": "tile-index-grid",   // data[row][col] = index into tiles.json (−1 = empty)
  "empty": -1,
  "data": [[0,0,1, ...], ...]
}]
```

To draw the terrain: for each `data[row][col]` index `i`, look up
`tiles.json.tiles[i]`, take its region `px:[x,y]` out of `tiles.png` (each tile
is `tile_size × tile_size`), and blit it at pixel `(col·tile_size, row·tile_size)`.
That's the whole renderer.

`tiles.json`:

```jsonc
{ "atlas":"tiles.png", "tile_size":16, "columns":16, "count":28,
  "tiles":[
    { "index":0, "tileset":"ocean_sand", "tile":"wang_0",
      "corners":{"NW":"lower","NE":"lower","SW":"lower","SE":"lower"},
      "atlas":[0,0], "px":[0,0] },
    ...
  ] }
```

### Why Wang tiles / corners (dual-grid)

PixelLab's tileset endpoint returns a **Wang set**: for two terrains (`lower`,
`upper`) it gives every tile for the 16 combinations of the four **corners** being
lower or upper, and neighbouring tiles connect seamlessly. So terrain is defined
on tile **corners**, not tile centres — the classic *dual grid*.

`corner_heights.data` is a `(height+1) × (width+1)` grid of terrain **level
indices**. A tile cell reads its four corners `NW=(r,c) NE=(r,c+1) SW=(r+1,c)
SE=(r+1,c+1)`; the tile whose `corners` match is the one to draw. The generator
guarantees adjacent corners differ by at most one level, so each cell spans a
single terrain boundary and always has a matching Wang tile. `data` in the
terrain layer is this lookup already baked to atlas indices — you don't have to
recompute it, but `corner_heights` documents the intent and lets you rebuild.

Multi-band terrain (water → sand → grass → forest) is handled by using one Wang
tileset **per adjacent pair** (`bands`) and choosing, per cell, the band matching
that cell's two levels. One opaque tile per cell, no layer blending.

### Objects

```jsonc
"objects": [
  { "id":"tree_oak", "file":"objects/tree_oak.png",
    "tile":[7,5],                // tile column,row
    "x":118, "y":72,            // top-left pixel to blit the sprite
    "anchor":"bottom-center",   // the sprite's base sits at the bottom-centre of the tile
    "blocks":true }             // contributes to the collision grid
]
```

Draw objects **after** terrain, ideally sorted by `y` so lower sprites overlap
higher ones (top-down depth). Sprites are transparent PNGs and may be taller than
one tile (a tree spans several tiles but is anchored to one).

### Collision

```jsonc
"collision": { "encoding":"walkable-grid", "width":22, "height":18,
               "legend":{"0":"walkable","1":"blocked"},
               "data":[[1,1,0, ...], ...] }
```

`data[row][col]` — `0` walkable, `1` blocked. Water and walls are blocked from the
terrain; blocking objects add their footprint. Use this directly for movement /
pathfinding.

### Exits (loading zones)

```jsonc
"exits": [
  { "id":"dock", "kind":"dock", "tile":[10,17], "x":160, "y":272,
    "to_zone":"harbor_town", "to_exit":"dock" }
]
```

Each exit is a point in this zone that leads to another zone. When the player
steps on `tile`, load `to_zone` and place them at that zone's exit named
`to_exit`. `to_zone: null` means an unconnected edge you can wire up in your game.
This is how zones chain into a world: island `dock` ↔ harbour `dock`, cabin `door`
↔ the island it sits on.

---

## Using a zone in a game (minimal recipe)

```
load zone.json
atlas   = load(tiles.png)                      # or the per-tile PNGs in the source tileset
tiles   = zone.tileset via tiles.json
for row,col in grid:
    i = layers[terrain].data[row][col]
    if i >= 0: blit(atlas, tiles[i].px, at=(col*ts, row*ts))
for obj in sorted(objects, by y):
    blit(load(obj.file), at=(obj.x, obj.y))
collision = zone.collision.data                # 0 walkable / 1 blocked
on player entering an exit.tile: goto exit.to_zone @ exit.to_exit
```

Nothing outside the zone folder is required. The format is deliberately close to
[Tiled](https://www.mapeditor.org/)'s model (tile layers + tilesets + object
layer + a collision grid), so it maps cleanly onto most engines.

---

## Running the loop

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...            # kept in a gitignored .env; never committed

python pipeline/loop.py --max-minutes 50    # bounded chunk (for a Routine)
python pipeline/loop.py --once              # one unit
python pipeline/loop.py --max-units 5 --no-push
```

Each **unit** is one PixelLab op (generate a tileset or an object) or one zone
assembly (free — pure local composition). The loop reads the filesystem to find
the next missing unit, so it's fully **resumable**; after each unit it rebuilds
`viewer_data.json`, commits, and pushes. It stops cleanly when the PixelLab
balance drops below `budget.min_generations_remaining`.

Order: build the explicit `zone_plan` first (small islands first, as intended),
then keep inventing fresh islands from `config/maps.json:procedural_zones`.

### Adding your own zones / terrain / props

- **New terrain**: add a Wang tileset to `config/maps.json:tilesets`
  (`lower`/`upper` descriptions).
- **New prop**: add to `objects` (`description`, `size`, `on`, `blocks`).
- **New zone**: append to `zone_plan` (`archetype`, `grid`, `levels`, `bands`,
  which `objects`, optional `town_size`/`houses`, and `links` to other zones).

## Viewer

Browse `*/preview.png` directly in the GitHub mobile app, or enable GitHub Pages
and open `index.html` for a zone gallery that reads `viewer_data.json`. Works
locally too: `python -m http.server` then open `/maps/`.

## PixelLab features used

- **`create-tileset`** — Wang terrain tilesets (seamless, corner-classified).
- **`map-objects`** — transparent props (trees, houses, furniture).
- **`create-image-pixflux`** — available in the client for whole-scene backdrops.

Style knobs (`view`, `outline`, `shading`, `detail`, `tile_size`, seeds for
reproducibility) are passed through from `config/maps.json`. See
[`spec/MAPS_SPEC.md`](spec/MAPS_SPEC.md) for the full design.

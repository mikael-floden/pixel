# Pixel Maps

Automated, PixelLab-backed **map** generator — the map counterpart to the
[characters](../characters/) and [objects](../objects/) domains. It builds
**explorable loading-zone screens** for a top-down 2D game in the *Grave Seasons*
/ Stardew Valley look.

**Approach (v2 — scene-based):** PixelLab **draws** each screen as a cohesive
painted scene (`create-image-pixflux`), art-directed with a palette reference —
*not* flat Wang tiles (those looked amateur; a drawn scene matches the character
art). On top of the painted ground we derive a walkable **collision** grid, place
**props from the objects agent** on a y-sorted **entity layer** (so the character
passes in front of / behind them), add **exits**, and write a self-contained
`zone.json`. Big islands are several screens linked by exits.

> Maps are **not** visible on pixellab.io — that only shows the raw generated
> images. The maps are assembled here in the repo.

---

## Layout

```
maps/
  README.md            you are here
  spec/MAPS_SPEC.md    design + loop
  config/maps.json     style, palette ref, prop scales, zone list
  style/palette.png    palette reference fed to PixelLab for cohesion
  pipeline/            pixellab_client, props, scene, proportions, coordination, loop, viewer_build
  index.html           phone viewer
  <zone_id>/           EACH such folder is one loading zone (has zone.json)
    scene.png          the PixelLab-drawn painted background (the world canvas)
    zone.json          the map data (below)
    objects/*.png      the prop sprites this zone uses (copied from the objects agent)
    preview.png        background + placed props, depth-sorted (for humans)
    collision.png      walkable-grid visual (red = blocked)
```

A **zone** = any top-level `maps/` subfolder containing a `zone.json`.
`pipeline/`, `config/`, `spec/`, `style/` are infrastructure.

---

## The map data format (`zone.json`, schema `pixel-maps/zone@2-scene`)

```jsonc
{
  "id": "isle_glade", "title": "Forest Glade", "kind": "island_screen",
  "background": "scene.png",                 // the painted world image
  "pixel_size": { "width": 960, "height": 672 },
  "camera": { "viewport": {"width":480,"height":336},
              "note": "world > viewport; scroll to follow the player" },
  "layers": ["background", "entities", "overhead"],
  "collision": {                             // walkable grid derived from the scene
    "encoding": "walkable-grid", "cell": 48, "width": 20, "height": 14,
    "legend": {"0":"walkable","1":"blocked"}, "data": [[1,1,0,...], ...] },
  "spawn": { "x": 470, "y": 360 },           // where to place the player
  "entities": [                              // props on the y-sorted layer
    { "id":"oak_tree", "file":"objects/oak_tree.png",
      "x":220, "base_y":540, "layer":"entity" } ],
  "overhead": [],                            // tops that always draw over the player
  "exits": [ { "id":"north", "kind":"path", "edge":"north",
               "x":480, "y":0, "to_zone":"isle_shore", "to_exit":"south" } ]
}
```

### How a game renders it (recipe)

1. **Background** — draw `scene.png`. It's larger than the screen; the **camera**
   draws the sub-rectangle around the player and scrolls to follow → bigger world.
2. **Entities** — draw props **and the player** as one list sorted by `base_y`
   (feet Y), back-to-front. Lower feet draw last ⇒ the player is *occluded by*
   props in front and *draws over* props behind. That's front/behind depth.
   Each prop's `x`,`base_y` is its base (bottom-centre); the sprite is `file`.
3. **Overhead** — draw any `overhead` sprites (tall canopy/roof tops) last, over
   the player, so they can walk "under" them (each with its own collision).
4. **Collision** — `collision.data[row][col]` (0 walkable / 1 blocked), cell size
   `collision.cell` px. Use for movement/pathfinding. Derived from the painted
   ground (clearing walkable; foliage/water blocked).
5. **Exits** — when the player reaches an exit's edge/tile, load `to_zone` and
   spawn them at that zone's `to_exit`. Screens chain into an explorable island.

Nothing outside the zone folder is needed to render it (props are copied in).

### Scale / proportions

One shared scale keeps it believable: the on-map **character ≈ 20 % of screen
height** (~2 "character-heights" fit vertically per screen region), and props are
sized as a multiple of the character (a tree ≈ 1.3×, a chest ≈ 0.45×) — see
`pipeline/proportions.py`. Props come from the **objects agent**; maps never
generate props.

---

## Running the loop

```bash
pip install -r ../requirements.txt
export PIXELLAB_API_KEY=...        # gitignored .env; never committed
python pipeline/loop.py --once           # build the next un-built zone
python pipeline/loop.py --max-minutes 50 # a scheduled chunk
```

Each unit = one drawn scene + assembly (one PixelLab op). The loop finds the next
zone in `config/maps.json:zones` without a `zone.json`, builds it, rebuilds the
viewer, publishes a coordination heartbeat, commits and pushes. Resumable and
budget-aware (stops below `budget.min_generations_remaining`).

### Adding zones / changing the look

- **New screen:** add a `zones` entry (`prompt`, `mood`, `props`, `exits`).
- **Cohesion / mood:** the look is driven by `style/palette.png` + `style_base` +
  each zone's `prompt`. Swap the palette for a different season/mood.
- **Props:** reference ids from the objects agent's catalog (`/objects`); request
  new ones from that agent via the coordination board.

## Fleet coordination

Three agents (characters / objects / maps) share one repo, `main`, and one
PixelLab account — see [`../coordination/PROTOCOL.md`](../coordination/PROTOCOL.md).
Maps writes only `coordination/maps.json`, reads the others, references the
objects agent's props, and reserves a 2000-generation budget floor.

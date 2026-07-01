# Pixel Maps

The **Maps agent's** domain: it takes the isometric terrain tiles produced by
the **tiles agent** (`tiles/<category>/`) and assembles them into a single,
hand-designed-feeling **world** — the environment the game (`moonlight`) renders
players onto.

Part of the multi-domain `pixel` repo (alongside `characters/`, `objects/`,
`tiles/`). Everything for this domain lives under `maps/`.

## The idea

Not scattered tiles — a **designed** world. The goal is an *A Link to the Past*
overworld feel: a coherent island with an organic coastline, biome regions that
each have a *place and a reason* (highlands to the north, forest to the east,
fertile plains in the centre), terraced elevation, a river from the peaks to the
sea, and real landmarks — a walled **castle** on a plateau and a **harbor town**
on the coast — tied together by **logical roads**.

Assembling a world is **pure compositing** of tiles that already exist, so this
domain needs **no PixelLab key and makes no API calls**. It owns orchestration,
layout design, and the viewer.

## Layout

```
maps/
  README.md
  config/world.json          design intent + default seed/size knobs
  pipeline/
    tileset.py               loads tiles/, measures the shared iso geometry
    world.py                 the World data model (grid of cells) + JSON persistence
    render.py                composites a World into one isometric PNG
    designer.py              the "designer brain": init + iterative improvements
    build.py                 CLI entrypoint (grow / edit / render)
  world/
    world.json               the persistent world (source of truth, human-readable)
    world.png                the rendered isometric world
  index.html                 viewer (shows world.png + region list)
```

## How the tiles fit together

Every tile is a 64×64 isometric block (diamond top + 50%-thickness side faces),
all drawn to the same house format, so they share one grid. `tileset.py`
measures the geometry straight from the pixels; for cell `(col, row)`:

```
screen_x = origin_x + (col - row) * 32          # TILE_W/2
screen_y = origin_y + (col + row) * grid_dy     # half the diamond-top height
```

Draw **back-to-front** (increasing `col+row`). **Elevation** is built by
*stacking* the same 64×64 blocks — each level raises the surface by one
tile-thickness — exactly the method the tiles agent documents. Mountains rise in
terraces and the castle sits on a plateau this way, using the ground tiles we
already have (dedicated `cliff_*` elevation sets can slot in later for nicer
vertical faces).

## Running it

```bash
pip install -r ../requirements.txt        # Pillow + numpy (no API key needed)

python pipeline/build.py --init           # lay the first draft island
python pipeline/build.py --iterate        # ONE deliberate improvement, then re-render
python pipeline/build.py --steps 5        # several improvements
python pipeline/build.py --render-only    # just re-render the current world
python pipeline/build.py --scale 2        # bigger PNG (nearest-neighbor, crisp)
```

`world/world.json` is the source of truth; each run mutates it a little and
re-renders `world/world.png`. It's filesystem-driven and resumable, matching the
repo's per-unit rhythm — commit + push after each unit.

## The design loop (`designer.py`)

`init_world` composes the first draft in deliberate passes: landmass → beaches →
placed biome regions → terraced highlands → river → castle → town → the king's
road.

`iterate` performs **one** improvement per call, in priority order — add a dock,
ring the town with farms, deepen the forest, found a forest hamlet, or **extend**
the world with a new coastal frontier — always leaving it better and bigger. This
is where we keep iterating on what "a beautiful, interesting world" means.

## Coordination

Shares the repo / `main` / PixelLab pool with the other agents (see
`../coordination/PROTOCOL.md`). This agent writes only `coordination/maps.json`,
reads the others, and references `objects/` props by id for on-map decoration.
It consumes `tiles/` read-only and never edits another domain.

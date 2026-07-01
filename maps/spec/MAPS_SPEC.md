# Maps Spec — Scene-based Map Factory (v2)

## Goal

Automated, resumable generation of **explorable loading-zone screens** for a
top-down 2D game in the *Grave Seasons* / Stardew Valley look — the map
counterpart to the characters and objects domains.

## Why scene-based (v1 → v2)

v1 tiled PixelLab **Wang tilesets** for terrain. They come out flat and noisy and
clashed hard with the painterly character/object art (looked amateur). v2 lets
PixelLab **draw** each screen as a cohesive painted scene
(`create-image-pixflux`), art-directed with a **palette reference image** for
cohesion. Reference-guided *scenes* look right; reference-guided *tiles* don't (a
32px tile is too small to carry style). All v1 tile artifacts were removed.

## Definitions

- **Zone / screen** — one drawn loading zone: `maps/<id>/` with a painted
  `scene.png` (the world canvas, larger than the viewport), a `zone.json`
  (collision + entities + exits + spawn + camera), copied prop sprites, and
  previews.
- **Prop** — a sprite from the **objects agent** (`/objects`). Maps never generate
  props; it references the catalog and requests missing ones via the board.
- **Island** — several screens linked by `exits` (screen-to-screen, like the
  reference game), giving a large explorable world.

## Pipeline

- `pixellab_client.py` — balance, job polling, `create_scene` (pixflux, palette-
  guided). No tileset/object generation.
- `props.py` — load objects-agent props (`sprite.png` + `object.json`), scaled for
  the map.
- `proportions.py` — the scale contract (character ≈ 20 % of screen height; props
  sized relative to it) + config validation against the objects catalog.
- `scene.py` — generate the scene → upscale to world canvas → derive collision →
  place props on a y-sorted entity layer with shadows → exits → write `zone.json`.
- `loop.py` — build the next un-built zone; rebuild viewer; heartbeat; commit +
  push. Resumable, budget-aware.

## Rendering model (for the game engine)

Layers: **background** (scrolling painted scene) → **entities** (props + player,
y-sorted by base/feet Y for front/behind depth) → **overhead** (tall tops drawn
over the player for walk-under). Collision is a walkable grid derived from the
painted ground. Camera draws the sub-rect around the player and scrolls. Full
format + recipe in `../README.md` (schema `pixel-maps/zone@2-scene`).

## Scale contract

On-map character ≈ 20 % of screen height; props sized as multiples of the
character (tree ≈ 1.3×, chest ≈ 0.45×). Aligns with the objects agent's `placement`
metadata (their sprites are authored ~64px for a 64px character).

## PixelLab integration (verified)

- `create-image-pixflux` → `{image}` synchronously; accepts `color_image`
  (palette/style reference — the cohesion lever), `view`, `outline/shading/detail`,
  `seed`. width/height 32–400.
- `GET /balance` → `subscription.generations` for the budget floor.
- Note: the API has **no delete for tilesets**, so any abandoned v1 tilesets on
  the account can only be cleared in the web UI.

## Coordination

Shared repo / `main` / PixelLab account across characters/objects/maps
(`../coordination/PROTOCOL.md`). Maps writes only `coordination/maps.json`, reads
the others, references objects-agent props, and keeps a 2000-generation floor. The
autonomous cron (`.github/workflows/maps.yml`) is paused during the redesign; run
manually via workflow_dispatch until re-enabled.

# `pixel-maps3/world@1` — Tiles 3.0 worlds (maps2/worlds3/)

> "Recreate the_island2 with v3 tiles and call the new map the_game … put the
> new 3.0 map in a new folder so the game doesn't have to know about it until
> you are done and we are ready for the real game migration." — maintainer,
> 2026-08-24

`maps2/worlds3/<name>/world.json`. **Nothing the game ships scans this folder**
(verified: `build-worlds.mjs` and `WorldRoom` read exactly `maps2/worlds/`) —
the migration is judged from renders before the game learns the format exists.

## The format stores SEMANTICS, never tile paths

A v2 world bakes 4,693 tile paths. A v3 world stores a **ground type per cell**
and resolves art at draw time through the tile system's own rules — which is
what makes the maintainer's future verdicts flow into the map with **no
rebuild**: promote a base tile and every field of that ground repaints; approve
a `#top` detail and it starts appearing; generate the missing transition set
and the fade upgrades itself to art.

```jsonc
{
  "schema": "pixel-maps3/world@1",
  "name": "the_game",
  "size": {"w": 248, "h": 248},
  "grounds": ["black_rock", "brown_paving_stone", ...],   // legend
  "liquids": ["water", "deep_water"],                      // subset of grounds
  "ground": [[legend index per cell]],                     // -1 = void
  "level":  [[elevation per cell]],
  "spawn":  [x, y],
  "decks":  [{"kind": "roof|bridge|cave", "level", "thickness",
              "ground", "cells": [{"x","y"}]}],
  "scenery": [{"piece": "trees/tree_014", "x": 123.5, "y": 88.5,
               "hflip": true}]                              // off-grid, fractional
}
```

## How art resolves (the renderer contract — `maps2/pipeline/render3.py`)

| layer | source | rule |
|---|---|---|
| iso | `tiles/review/manifest.json` iso block | 64px tile, dx 32, **dy 14** (GEOMETRY.md: the pitch where the v3 lattice closes; 15 leaks a 1px wall grid), storey pitch **measured** per tile (`tiles/pipeline/render.py wall_height` — assuming 17 leaks a stripe of the floor below at every storey, the tiles agent's own paid-for bug) |
| fields | `tiles/ground_types.json` + `live/tuning/base_tiles.json` | `surface: flat/own` with no promoted base tile → the single flat `base_color`. `surface: base` (paving, parquet) → the ONE published base tile repeated. **THE LAW: no agent introduces texture — a field repeats what the maintainer promoted, or a flat colour.** |
| walls | `tiles/review` x-over-y matrix | **the only tiles that ever show a wall.** A column stacks whole tiles (the tiles agent's `plateau` model): same-over-same for every storey below, capped by `top__over__side` where `side` = the ground at the face's FOOT (down-screen lower neighbour) — never an indoor floor, never a liquid — overridable per pair via `live/tuning/tile_walls.json`. Candidate per cell = the wiki's own rule: maintainer-approved, else rank 0. |
| boundaries | `tiles/transitions/<a>__to__<b>/<set>/post/` | Wang corner sets on the **corner lattice** (a drawn tile's corners are the 4 cells of a quad; index `8*NW+4*NE+2*SW+1*SE`, set bit = the set's `upper`). One set per pair. Only where the quad shares one level — a level change is a cliff, not a blend. |
| fades | renderer fallback | a pair with **no committed set** paints the two grounds' palette colours through a borrowed mask set's geometry — no texture invented. Every fade is logged at build; the log is the shopping list of transition sets to generate. |
| details | `live/feedback/tiles.json` `<key>#top` approvals | sprinkled ~1/48 field cells. **Zero approved today → the layer draws nothing.** Fills as he approves tops in the wiki. |
| scenery | `scenery/<piece>/scenery.json` | sprite scaled so height = `placement.world_px_height`; feet at (x,y); `hflip` honoured (`must_be_imbplemented_with_random_hflip`); pieces under roof/cave decks skip (indoors). Hitbox: no canonical field ships in scenery yet — flagged; collision should be art-measured from the sprite base until scenery publishes one. |

## the_game's translation (world3.py, all rules)

v2→v3: saturated_grass→grass, regular_snow→snow, crystal_ice→ice,
black_mountain→black_rock, stone_mountain→grey_stone, light_sand→light_beach,
lightdark_dirt→light_soil, clear_water→water. **New ground, by rule:**
`deep_water` = open sea >7 cells from land (the ocean gets depth);
`dark_mud` = the riverbank strip (level≤4 grass hugging channel water);
`parquet_floor` = the floor inside both houses; `brown_paving_stone` = the
stone-house yard; roof decks wear `grey_paving_stone` (v2 slate was
black_mountain; a flat near-black slab is not a roof — taste call, flagged).
Lava and slime are deliberately unplaced — nothing on this island says volcano,
and that big a taste call is the maintainer's.

Scenery species follow the GROUND under the old prop: grass→trees (rotating the
approved pool, hflip alternating), snow/ice→crystal_trees, rock→rock_spires,
beach→rowboats/bushes; the chess tables are their own scenery pieces.

## Known gaps (the maintainer's shopping list)

- `grass__to__light_soil` — the ROAD edge — is **queued but never generated**
  (`tiles/transitions/jobs.json`, 15 jobs, generation is maintainer-side).
  Until then the road edge is a fade.
- All liquid boundaries (`water~deep_water`, `light_beach~water`) are fades —
  no sets exist for liquid pairs.
- No base tiles promoted, no `#top` details approved → every field is flat and
  detail-less by law, and upgrades itself the moment verdicts land.

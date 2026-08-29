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
  "walls":  [{"side": "grey_stone", "cells": [{"x","y"}]}],  // authored wall body
  "ramps":  [{"from": 0, "to": 4, "ground": "light_soil",
              "cells": [{"x","y"}, ...]}],                   // THE WAY UP
  "scenery": [{"piece": "trees/tree_014", "x": 123.5, "y": 88.5,
               "hflip": true, "lit": true}]                  // off-grid, fractional
}
```

### `decks` — a roof deck is GAMEPLAY, not decoration

A `kind: "roof"` deck is how the world says **"this is indoors"**. The game's
indoor system keys on a roof deck over the player: it is what blacks out the
world outside and fixes the draw order. Deleting one does not remove a
decoration, it breaks every interior in the running game — measured
2026-08-30, in production, by deleting them to make the roof thin.

* Every enclosed room carries a roof deck over its **whole footprint** — walls
  and doorway included, exactly as v2 did. Narrowing it to the interior leaves
  the DOORWAY unroofed, because the door is a gap in the wall ring and so has
  no wall course of its own to roof it.
* **`thickness` is EXTRA face tiles BELOW the top; 0 means the top course
  only.** This is the game's own definition (`games2/shared/src/index.ts`), and
  a roof deck always uses 0. A renderer that floors it at 1 hangs a storey of
  wall down into the doorway, and the door then measures 4 tiles with 2 above
  it instead of 5 with the roof on top (measured 2026-08-30 — `render3.py` had
  `max(1, th)`; the game was right and the reference render was lying).
* **A house is 6 tiles tall: 5 of door, 1 of roof** (maintainer, 2026-08-30;
  v2's `islandworld2.HOUSE_WALL = 6` said the same). The wall ring rides at
  base + 6 and its top course IS the roof, so the doorway stands 5 clear.
* A deck may carry a **`side`**, and is then drawn `ground` OVER `side`. That
  is what makes a roof THIN: a material is thin when it is only the TOP of an
  x-over-y pair (grass over black_rock is a skin of grass; grass over grass
  fills the cell and reads as a slab — the maintainer's own two reference
  tiles, 2026-08-30). House roofs are `brown_paving_stone` over `parquet_floor` (maintainer, 2026-08-30). With
  no `side` a deck draws same-over-same, which is the thick look.
* Changing decks changes gameplay. Tell the games agent before it lands.

### `ramps` — the contract with the game

A level change is a cliff. A **ramp** is where the world says a climb is
legal, so the game does not have to infer one from the heightfield.

* `cells` is an **ordered, 4-connected run**, foot first. Between any two
  consecutive cells the level differs by **exactly 1** — build-asserted.
* `from` / `to` are the levels of the first and last cell. A run is
  **monotone**: a chain that rises then falls is published as two runs.
* The rule the game implements: **movement between two adjacent cells whose
  levels differ is permitted iff both are consecutive cells of the same
  ramp.** Everywhere else a level change stays solid. Entering or leaving a
  ramp end from a same-level neighbour is ordinary movement, no special case.
* The player's height on a ramp cell is that cell's own `level` — there are no
  fractional levels, which is what keeps collision, draw order and the wall
  model unchanged.
* Ramps are carved by a **max-slope relaxation over the road graph alone**
  (world3grow.ramps): while two adjacent road cells differ by more than one
  level, both move one toward the other. It converges to a road that is
  walkable end to end and it never touches a cell that is not road. On
  the_game: 61 runs, longest climb 4 levels over 5 cells, and **zero road
  steps greater than one level remain anywhere on the map**.
* Art is independent of this contract: the renderer dresses a rise with the
  slope library where an approved set exists, and the ramp is still a ramp
  where it does not.

## How art resolves (the renderer contract — `maps2/pipeline/render3.py`)

| layer | source | rule |
|---|---|---|
| iso | `tiles/review/manifest.json` iso block | 64px tile, dx 32, **dy 14** (GEOMETRY.md: the pitch where the v3 lattice closes; 15 leaks a 1px wall grid), storey pitch **measured** per tile (`tiles/pipeline/render.py wall_height` — assuming 17 leaks a stripe of the floor below at every storey, the tiles agent's own paid-for bug) |
| fields | `live/tuning/base_tile_sets.json` | **his base tile sets, on every cell — land, liquid, deck and raised alike.** A SET per region (a 24-cell chunk of one ground), a MEMBER per cell, his weights throughout, clean as a member. A member draws **its own art**: the review candidate's published `textured` pass, or the file itself for a `tops`/`base_candidates` path, conformed into plate geometry. **Never `tiles/plates/<g>/<key8>.webp`** — that is the same tile flattened to the clean colour, and reading it painted 236 of his 340 members flat. A member he later **rejected** is dropped, his rejection outranking his set. (`live/tuning/base_tiles.json` is the superseded one-tile-per-ground channel and is empty.) |
| walls | `tiles/review` x-over-y matrix | **the only tiles that ever show a wall.** A column stacks whole tiles (the tiles agent's `plateau` model): same-over-same for every storey below, capped by `top__over__side` where `side` = the ground at the face's FOOT (down-screen lower neighbour) — never an indoor floor, never a liquid — overridable per pair via `live/tuning/tile_walls.json`. Candidate per cell = the wiki's own rule: maintainer-approved, else rank 0. |
| boundaries | `tiles/patterns` x `tiles/plates` | patterns publishes the **material-independent** Wang boundary and nothing else; the two grounds it divides come from their own set members. So **every pair is covered**, including roads (`light_soil` beside `grass`, the 2nd most common boundary on the_game) — no per-pair set is required. Corner lattice, index `8*NW+4*NE+2*SW+1*SE`; each half asks for **its own ground's** region. Only where the quad shares one level. |
| fades | `tiles/fades` (`tiles3/fade-tiles@1`) | top-only mix tiles that warm the player up for a ground change **before** the switch. Placed by `edge_ground`, never by area majority ("big rocks ON an ice sheet"). **APPROVED ONLY** — he rates this layer actively (480 approved, 345 rejected of 3,575), so an unjudged tile is not a candidate; survivors are weighted by his rating. A **scattered event** over a real Chebyshev distance band, never a coat of one tile. |
| details | `live/feedback/tiles.json` `<key>#top` approvals | **478 approvals.** The wiki's roof glyph is "rating the TOP as a once-in-a-while ground detail", and a tile **rejected as a pair** (bad wall) can still be a top-approved detail — the two reviews are independent by design. Drawn from the `textured` pass and conformed, so a detail's foreign lava/ice/sand wall never leaks into a field. |
| slopes | `tiles/slopes` (`tiles3/slopes@1`) | a Wang set on **elevation** (bit = that corner is raised), same 64x46 frame as a plate. A cell takes the graded tile when its **own** ground rises beside it. **Gated per tile on his verdicts** — he has judged 15 of 225 sets, so `light_soil` and `water` get no slope rather than an invented one. Every published set is a **4px sub-storey** grade: it softens the foot of a rise, it cannot bridge a 17px storey (storey-height sets requested from tiles). |
| toggles | `live/tuning/tile_walls.json`, `top_walls.json`, `tile_tops.json` | `top_only` (this tile's wall is unusable) **paired with** `wall:` (the wall it borrows instead) — two files, and reading only the first left the mark dead. `own_top` keeps the x-over-y tile's own top instead of painting the set surface over it. |
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

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
  "rooms":  [{"ground": "parquet_floor", "cells": [{"x","y"}]}], // ONE FLOOR EACH
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

### `rooms` — where a room ends, stated rather than guessed

```jsonc
"rooms": [{"ground": "parquet_floor", "cells": [{"x","y"}, ...]}]
```

**One floor tile per room** (maintainer, 2026-08-30, twice: *"When building
houses use 1 Parquet Floor per room"*, then *"the same room should only have
one type of Parquet Floor. You use several different Parquet Floor in the same
room"*). A consumer picks the base-tile SET and MEMBER once per room — at the
room's anchor, `min(cells)` — instead of once per cell.

It has to be published because it cannot be inferred:

* **not from the chunk grid** — sets are chosen per 24-cell chunk and buildings
  straddle chunk borders (the town hall spans x 406–420, y 352–363; the chunk
  edges fall at x=408 and y=360), so one room took two sets;
* **not from the roof deck** — a deck covers a whole building, and its cells
  include the wall ring, whose tops are the roof material at the deck's own
  level;
* **not per render window** — a room clipped by the window would take a
  different anchor, and the same floor would change tile between two renders.

A room is a connected (4-neighbour) patch of indoor floor: same ground, under a
roof or cave deck, carrying no wall, and lying BELOW its deck — and **a doorway
does not conduct**. A doorway is a floor cell with wall on both opposite sides;
flooding through them merged the town hall's three chambers into one 116-cell
patch, and the maintainer counts rooms by their walls ("that looks like 3 rooms
to me", 2026-08-30). Each doorway then joins the neighbouring room with the
lower anchor, so no indoor floor cell is left without one. the_game publishes
13 rooms / 262 cells; the town hall is 3 (32 + 30 north of its dividing wall,
54 in the hall south of it). The channel is additive — no cell, deck, wall or
level changes — so collision, indoor detection and draw order are untouched.

**A ROOM IS A FLOOR, AND THE ROOM MAP MUST NOT REACH A ROOF.** The channel
exists so an indoor floor lays as ONE board — every cell of a room asks for its
set and member at the room's anchor. A deck's top surface went through the same
function with its own coordinates, so each roof cell over a room took THAT
room's anchor and each wall cell took its own: the plan of the house, inner
walls included, painted onto its roof and readable from outside (maintainer
2026-09-05, drawing it on a render of mine: *"It's as if you define the rooms
both for the roof and indoor. A player see the entire house including walls
tops as the house roof and expect the entire house to have the same
tiling"*). A surface that is one thing to the player asks ONE question: a deck
anchors at its own up-screen-most cell, so a roof is one set and one member
from eave to eave, whatever is under it — which also stops a 24-cell region
border from cutting a roof in two (a 15-cell-wide house straddles one).
`render3.plate_img(..., anchor=)`; **games2 consumes `rooms` for the same
purpose and needs the same rule** — raised on their board.

### `scenery` — a placement is centred on its HITBOX, not its art

**The hitbox centre stands in the middle of a tile** (maintainer, 2026-08-30:
*"the game will mark that spot in the nav as a tile we must navigate around —
so we want that ground we now have to navigate around to match the scenery
hitbox as good as possible"*).

`x`/`y` is where the art is ANCHORED (its alpha-bbox bottom-centre), which is
not where its footprint is. The offset between them is the piece's own
business — its ellipse can sit well off the anchor — so the cell the game
blocks landed wherever that offset fell. `world3grow.snap_hitboxes()` nudges
every piece that publishes a footprint (always less than one cell) so its
hitbox centre lands on a cell centre, which the game writes as
`(col + 0.5, row + 0.5)`.

The centre is computed with the game's own arithmetic (client `fitSprite` +
the overlay's `hbX/hbY`, `games2/client/src/scenery3.ts`) and the game's own
maps3 geometry (dx 32, dy 14): ellipse in FRAME pixels from the frame centre,
anchored at the DRAWN sprite's bbox bottom-centre, screen offset back through
the projection. Several ellipses on one piece are centred by their
area-weighted centroid. Sources: `games2/config/scenery-bbox.json` and
`live/tuning/scenery_hitbox.json` (his overrides win, and a piece with no
record is left alone).

**THE SCALE IS THE DRAWN ONE, AND THE SOURCE IS `scenery/`, NEVER
`games2/config/scenery-bbox.json`.** The drawn height is
`world_px_height × 88 / character_height_px` (games2 `sceneryDrawnPx`), read
from the piece's own `scenery.json` — `maps2/pipeline/sceneryscale.py`. The
cached bbox doc is a build artefact that nothing regenerates, and it went stale
the moment the scenery domain re-derived every piece (2026-09-05, *"ONE SCENERY
PIXEL IS ONE PLAYER PIXEL"*): `bed_001` declares 107 px against an 87-px
character while the cache still says 47 against 64 — a factor of **1.66**.
Anything reading the cache places furniture at two thirds of the size the game
draws, which is a room full of overlapping furniture. (games2's own collision
stamp still reads the cache; raised with them.) The ellipse sits at a SCALED offset from the art's anchor,
so reading the raw contract number centred the footprint at 1/1.375 of the real
offset and left it **up-screen of the cell it blocks: median 3.0 screen px over
892 placements, always up** (maintainer 2026-09-04, overlay screenshot: *"the
hitbox touches the top and have a small distance left to the bottom"*). One
rule, one place: `maps2/pipeline/sceneryscale.py`, which PARSES
`CHARACTER_BODY_PX` out of games2's source rather than copying it. The same
number is what a reference render must draw at — at the contract's number every
piece in `render3.py` was 27% small, so no render of mine showed the crowding
the game shows.

Measured on the_game with the game's own cell test: pieces whose ellipse covers
no cell centre — and which therefore block **nothing** — fall from **550 of
1,421 (39%) to 11**, and the centring error from median 3.0 px to **0.00**.
The footprints got accurate, not bigger. Build-asserted every run.

**A RECT BOX IS READ PER FACING — all three channels.** `shape:"rect"` means
the footprint is a rectangle on the ground, and the wiki writes three
independent per-facing overrides (`wiki/site/wiki.js` boxPos/boxSize/boxRot);
a consumer that reads only some of them draws a different rectangle from the
one he drew:

| channel | what it overrides | why it exists |
|---|---|---|
| `pos_by_dir[d]` | `ax`, `ay` | *"the move tool is per direction"* — the art's anchor is not the same point on every facing |
| `size_by_dir[d]` | `rx`, `ry` | *"we need a dedicated W and D for the S direction ... as an opt-in"* — 54 of 131 rect pieces have a south view whose footprint disagrees with its own turned views, so one rectangle cannot serve every facing |
| `rot_by_dir[d]` | degrees | otherwise `rot − GROUND_DEG[d]` for a rect (an ellipse just takes `rot`) |

Absent means the shared value. The corners are centre ± rx·**eu** ± (ry/K)·**ev**
with `K = dy/dx = 14/32`, `th = radians(rot − GROUND_DEG[d])`,
`eu = (cos th, sin th·K)`, `ev = (−sin th, cos th·K)` — the game's K, not the
wiki's: its preview still solves on `data.json.iso` (dy **15**, tiles2), while
scenery lives in maps3 at dy 14, so the same `ry` reads 7.1% deeper on the
ground here than in the tool he tunes in. Raised with wiki.

**THE WALL DECIDES THE FACING, THE FOOTPRINT DECIDES THE GEOMETRY.** West wall
to `south-east`, north wall to `south-west`, always: that is the measured rule
(the backrest centroid) and it is what "the back is against the wall" means.
Deriving the facing instead from which way the piece's rect is longer looks
equivalent and breaks on the pieces that are not well formed - `cupboard_010`
publishes an ELLIPSE, so both facings measured the same, the tie took the
first, and a dresser stood in the middle of the room with its back to nothing
(maintainer 2026-09-04: *"It sticks out straight into the room ... Some shelfs
are good, but this one is horrible!"*). The footprint then decides where it
stands, for an ellipse piece as much as a rect one: the piece is put flush —
`x = x0 + deep − cx` — instead of snapped to a cell centre (an ellipse
piece used to be dropped on the wall cell's CENTRE and then snapped like a
loose prop: half a cell of gap and no facing rule at all). **It also
slides along that wall, into the corner first**: centring a piece on the wall
cell it was handed is only right for a piece shorter than one cell, and a bed
is 1.4 cells long, so on the first cell of a wall half of it lay in the wall
round the corner and the footprint law refused the whole piece — a bedroom with
no bed in it (maintainer 2026-09-04: *"I told you to place furnitures edge to
edge with the wall/corner"*). The along-wall centre is clamped inside the wall's
own run, which IS the corner at either end, then walked outward in half cells
until the whole footprint is on free floor.

**A HOUSE IS NOT ALL THE SAME HOUSE.** The WALL is one of three materials and
nothing else — `parquet_floor`, `brown_paving_stone`, `grey_paving_stone`
(maintainer 2026-08-30) — so the variety lives in the **roof and the floor**,
which are free (2026-09-05: *"You can use paving stone as well to create a
house out of stone ... place them on top of the mountain with snow on the roof
... What about dark mud as floor? What about tree as the roof and paving stone
in the rooms?"*). `parquet_floor` **is** the timber, so "tree as the roof" is a
parquet_floor roof. `HOUSE_STYLES` (wall, roof, floor):

| style | wall | roof | floor |
|---|---|---|---|
| timber | parquet_floor | brown_paving_stone | parquet_floor |
| stone | grey_paving_stone | grey_stone | dark_mud |
| longhouse | parquet_floor | parquet_floor | grey_paving_stone |
| brick | brown_paving_stone | grey_paving_stone | parquet_floor |
| highland | grey_paving_stone | snow | dark_mud |

the_game ships 5 timber, 2 longhouse, 2 stone, 2 brick and one **highland on
the mountain shelf** (`highest_pad`, level 46 — the massif's own materials, not
grass). **A FLOOR IS RECORDED, NOT INFERRED**: `house()` writes every interior
cell into `floor_cells`, because dark mud is also a fen and paving stone is
also a road, so "every connected patch of parquet_floor is a room" stops being
true the moment a house is not made of wood.

**NOTHING STANDS IN A DOORWAY.** The threshold is three cells — the gap in the
wall ring, the step outside it and the cell inside — and no footprint may touch
any of them (maintainer 2026-09-05: *"I tried to walk into this house, but you
have placed a barrel exactly at the entrance so I can't get in"*). The barrel
was legal under every other rule: against a wall, on free floor, clear of its
neighbours. A door is not a wall.

**A HOUSE IS SIZED BY WHAT STANDS IN IT.** At the drawn scale a bed's footprint
is **2.37 × 1.33 cells**, a hearth 1.51 × 1.65, a dresser 1.72 × 0.72 — so the
old 6×5 house, whose interior is 4×3, was a bed and a corridor (maintainer
2026-09-05: *"if you make a house this ultra small you can't expect to fit much
inside it"*). Houses are **8×7 / 9×7 / 10×8 outside** (interiors 6×5, 7×5, 8×6),
which takes a bed on one wall, a dresser and a hearth on the other, and still
has floor to walk on. And footprints keep `FP_GAP = 0.20` of a cell FROM EACH
OTHER rather than merely failing to overlap: a published footprint hugs the
piece's base while its art rises a cell above it, so two boxes a hundredth of a
cell apart still read as one heap.

**A TABLE IS FURNITURE TOO.** A table in the MIDDLE of the floor is a dining
arrangement, and it needs a room to be a dining room: the centre cell plus a
chair up-screen on two sides is three cells of clear floor, which a hall has
and a bedroom does not (maintainer 2026-09-04, on a table standing in front of
his bed in a 13-cell room: *"Who in their right mind places a table like this!
Why didn't you use SW and placed it against the wall?"*). So the middle table
is for rooms of **20+ cells**; every smaller room puts its table against a wall
like the rest of its furniture, with one chair drawn up on the side it can face
from (a chair only looks down-screen).

**THE FLUSH TOLERANCE IS 1e-3 OF A CELL, and it must be.** A placement is
written to `world.json` rounded to 4 decimals, so a piece placed exactly flush
reads back up to 5e-5 of a cell INSIDE the wall — and the footprint law runs
again over what was written. At a 1e-6 tolerance that read as "touches a wall"
and the piece was deleted: **53 removals instead of 84, and 735 placements
instead of 713**, entirely furniture that was correctly placed. 1e-3 of a cell
is 0.03 screen px.

**A NO-COLLISION PIECE IS FLOOR** (maintainer 2026-09-04, on the collision
overlay: *"Why does the show collision mode show the collision on a carpet that
doesn't even have a collision?"*). Resolution, the wiki's own order: the tuning
record's `no_collision`, else the piece's `scenery.json` `collision: false`.
Such a piece claims no ground — it may lie against a wall and under a table,
and nothing is refused for standing on it — but it still may not span a level
change or straddle the shore. **The game stamps it anyway**: the server hands
`stampSceneryCollision` only `scenery-bbox.json` and the hitbox doc, and
neither carries the flag, so a rug really does block its cells in the live nav
grid. Raised with games2; the fix is theirs.

**games2 divergence, reported not worked around:** the client draws (and sorts)
a variation through `k = drawnPx / BASE bbox height` (`fitSprite`'s `scaleH`,
which is what keeps a rotation's own proportions), while the collision stamp
divides by the DRAWN sprite's own bbox height. For the 337 placements here
whose variation is not the base's height the two disagree — worst
`driftwood_log_901#NOT_LIT_8`, 91 px against 64, a 42% error on the ellipse's
offset. maps2 aims at the ART (the draw path): it is what he sees through the
overlay and what draw order uses.

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
| scenery | `scenery/<piece>/scenery.json` + `live/tuning/scenery_hitbox.json` | sprite scaled to the height the GAME draws, `world_px_height × 88 / character_height_px` — **never the raw contract number** (`maps2/pipeline/sceneryscale.py`); feet at (x,y); `hflip` honoured (`must_be_imbplemented_with_random_hflip`); pieces under roof/cave decks skip (indoors). The hitbox is the wiki's, keyed `<path>#<state>` per variation, and the placement is centred on it — see above. |

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

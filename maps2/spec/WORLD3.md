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
  "walls":  [{"side": "grey_stone", "cells": [{"x","y"}]},   // terrain wall body
             {"side": "parquet_floor", "kind": "house", "cells": [...]}, // a building
             {"side": "black_rock", "kind": "cliff", "cells": [...]}], // dressed drop
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

### terrain — a step has to be visible, and the player must never see the fix

**A RAISED CELL DRAWS WALL FACES ON ITS SOUTH AND EAST EDGES ONLY.** Its north
and west edges draw nothing — the higher top simply lies over the lower ground
behind it — so a step you approach from up-screen exists only where the two
GROUNDS differ. Grass on grass is invisible (maintainer 2026-09-05: *"It's
really hard for me to know that this is an edge since both levels use the same
ground type"*). A drop to the south or east already reads as a fall: the grass
tile's own wall band is earth.

**THE PLAN: NO TWO TERRACES THAT MEET FACE-LESS SHARE A GROUND.** A terrace is
a 4-connected patch of one level. `terrace_grounds()` builds the graph of
terraces that touch where the LOWER one lies north or west of the higher, by a
drop of `STEP = 2` levels or more, along `EDGE_MIN = 4` cells or more (a
one-level step is a walkable slope; a two-cell contact is a corner, not a line
you misread). The graph is coloured **largest-first**, so the valley floor and
the big benches keep the ground they have, and a smaller neighbour that would
match takes the next ground in its own family — a **whole terrace**, never a
rim:

| family | keeps | becomes, in order |
|---|---|---|
| grass | grass | **dark_mud** below level 16 (a peat bench under a meadow), **grey_stone** above (a rocky rise), black_rock |
| snow | snow | grey_stone (the bare shoulder), black_rock, ice |
| grey_stone / black_rock / ice | its own | the other rock, snow |

Roads, floors, paving, beach and existing fens are never repainted — each is
already a contrast and already means something — and only a terrace's dominant
cells change. Ramps are `light_soil`, the road's own material, because a ramp
is where you walk. **Build-asserted:** zero touching pairs share a ground with
a colour free (the_game: 0 pairs, 0 forced).

Measured on the_game: grass 29,303 → 19,275 cells; dark_mud +9,089;
grey_stone from grass +1,069; the massif alternates snow / grey_stone /
black_rock shelf by shelf. Two palettes were built and rejected by eye before
this one: grey_stone as the lowland alternate from level 4 (grass 29,303 →
13,674, the middle benches a grey layer cake — that repaints the meadow, not
the hill) and constraining every touching side (the same, plus repainting for
edges that already show a fall).

**REJECTED, one build (2026-09-05): a one-cell contrasting lip along every
drop.** It read as a ring painted on to hide a bug (*"The player should never
think 'aah you added stone here to hide this problem'"*), and it ringed the
south and east faces too, which already show a fall.

### the mountain — nobody plays behind it

Maintainer 2026-09-05: *"I want it to be a steep hill ... make it impossible
to play/walk behind the mountain."* Then, at the first cut's edge: *"the
intersection between 'you can walk here' and 'you cannot walk here because
it's behind the mountain' looks ugly ... it looks as if you can fall down
into space. What we need is a clever system they used in A Link to the Past.
They just used forest that made it impossible to walk into."*

**WHERE THE MOUNTAIN HIDES THE GROUND IS A SCREEN FACT**, so it is computed on
the screen. A cell draws at row `(x+y)·14 − level·15`. In each screen column
`d = x−y` the **crown** — cells at `CROWN_MIN = 32` or higher, the mega
mountain and not the 5–7 level cliffs he wants to keep walking behind — has a
silhouette, the highest row any crown cell reaches. `mountain_back()`:

1. **cuts the back shoulders to the valley** — every cell up-screen of the
   crown between `SHOULDER_MAX = 12` and the crown, liquids from 12 up
   included (a mountain lake on a cut shoulder survived as a one-row stripe
   of water), takes the level and ground of the first valley-height cell
   further up-screen in its column (7,218 cells), so the ridge drops straight
   to land the player can see and walk;
2. **hides what the ridge covers** — every cell up-screen of the crown whose
   TOP DIAMOND, at its (cut) level, has any corner under the silhouette: the
   bottom corner (apex + 28) against its own column, the side corners
   (apex + 14) against the two neighbouring columns (`_under_ridge`; 3,857
   cells). Only `kind: "house"` wall cells and recorded floors are spared.

**THE FOREST THICKENS INTO THE MOUNTAIN.** The hidden cells stay LAND at the
valley's height — the wild (below) raises and plants them — except a
`MOAT = 3` cells of **void** (ground index −1) along the crown, so nobody
steps off the ridge: void refuses the move. Two pictures were built and
rejected before this one (maintainer 2026-09-05): a void band ("it looks as
if you can fall down into space" — the game culls by cell distance and does
not draw the ridge from the valley, 17 cells away, so the hole showed) and a
sea in its place ("some sort of moat"). What he asked for: *"a forest
extending in under the part hidden by the mountain — so the player reads it
as the forest is getting so thick I can't walk into it ... if the tree is
90% covered by mountain the player will think it extends all the way in."*
**Build-asserted**: every hidden cell's diamond, at its cut level, is at
least partly under the ridge, and every kept cell up-screen of the crown is
wholly above it.

**THE WILD** (`wild()`, right after the cut): the hidden floor plus every
land and pond cell within `WILD_DEPTH = 6` of it (BFS; houses, decks and
ramps excluded; roads are taken and turned to grass — a road left out was a
dead end at a 10-level drop) is one wooded plateau standing `WILD_RISE = 4`
above the ground it had, FLAT (a band that stepped down was three terraces
in stripes with room for eighteen trees), sealed on EVERY side: every band
cell is 3+ levels above every standable cell it touches that is not band,
water included, and sealed again right before the reachability audit because
passes in between move ground next to it (1,481 of the band's cells were
enterable through the sides and a level-12 lake on the first build). One
tree per `WILD_STEP = 2` cells each way, jittered, marked `wild: true` in
`scenery[]`: never thinned by species spacing (spacing exists so the player
can pass, and nobody passes here) and allowed to hang over the bank. Under
the ridge a tree is planted only where it still shows: its apex less
`TREE_PX = 140` must lie above the silhouette (no point drawing a tree the
mountain covers whole). the_game: 4,710 wild cells, 535 trees.
**Build-asserted**: no wild cell is reachable.

Three traps, each one build:
- **A plain void band without the cut**: the shoulders beyond the hidden band
  still poked above the ridge at levels 14–28 — the very "slope that starts
  to go down again".
- **Sparing every `walls[]` cell**: the terrain's own wall groups (world3
  `_terrain_walls`, the massif's shelf faces) are dressing, and sparing them
  left the last cell of every shelf standing in the void — a 28 / 24 / 20
  staircase of one-cell stripes behind the ridge ("steep, then mountain,
  then a steep, then mountain", 440 cells). A cut or voided cell now also
  leaves every terrain wall group.
- **Testing the level-0 base instead of the raised top**: it voided every
  valley cell whose top peeked over the ridge, so the first survivor showed a
  full six-storey face standing ON the crown. The void's edge is dressed by
  `cliff_faces` from the top's own pool, never as a shore (`_seadist`
  measures water and sand only; the pad field counts void as wet).

**`g()` returns "" on void**: index −1 would otherwise read as the LAST legend
entry, a void that answers "grey_paving_stone" and is walkable, buildable and
painted.

### cliff faces — the wall matrix is a palette, not a default

**A CLIFF FACE IS NEVER GRASS.** The renderer's default face is `top__over__
side` with `side` = the ground at the face's foot, so every grass drop showed
the grass wall tile and nothing else. Maintainer 2026-09-05, six photos: *"I'm
not that big fan of grass walls ... most tile types (not the liquid ones) look
better as cliff walls then grass. I'm especially a fan of black_rock and
grey_stone ... you could have beach as a wall near the ocean, etc. And
snow/ice to ... you don't use all the different wall textures I have actually
reviewed."*

`cliff_faces()` publishes a `walls` group with `"kind": "cliff"` for every
exposed south/east face of a natural top (not liquid, not a house, not indoor
floor, road or ramp). The side comes from a pool chosen by the top and the
foot, weighted, and one draw per (terrace, pool) hashed from the terrace anchor
— so a hill wears ONE face all the way round, two hills differ, and a rebuild
reproduces:

| pool | when | sides (weight) |
|---|---|---|
| highland | top is snow or ice | grey_stone 3, black_rock 2, ice 1 |
| rock | top is grey_stone or black_rock | black_rock 2, grey_stone 2, dark_mud 1 |
| shore | foot at water, beach, or within `SHORE_R = 2` of the sea | light_beach 2, grey_stone 1, black_rock 1 |
| lowland | everything else (grass, mud, soil) | grey_stone 3, black_rock 3, dark_mud 2, light_soil 2 |

The draw never equals the top when the pool has another choice (a grey_stone
top over a grey_stone face is the invisible same-over-same column). **Not a
hard rule, a palette** (maintainer: *"I don't want to set up any hard rule"*)
— weights and pools are the taste dials. **Build-asserted:** zero cliff faces
with a grass side. the_game: 1,867 faces — grey_stone 801, black_rock 607,
dark_mud 254, light_beach 172, ice 33.

`kind: "cliff"` groups are dressing, NOT walls: `_walls()`, `indoor_floors()`,
`rooms()` and the footprint police ignore them (a barrel against a cliff is
fine; only house walls keep the `FP_MARGIN`). The game reads `walls[]` by side
and cells and does not need the kind.

**ONLY A `kind: "house"` WALL KEEPS ITS OWN SIDE.** The terrain wall groups the
v2 port and island 2 carry (world3 `_terrain_walls`: light_soil below the
massif, grey_stone on it) are the old dressing. One build honoured them and
dressed only the gaps between them — a black column beside tan ones wherever a
cell had fallen out of the old group, and the same at every terrace corner
(maintainer 2026-09-05, four photographs: *"You often draw a single column in
a different ground and wall type! This looks extremely ugly!"*). Every natural
face is dressed by this pass, a dressed cell leaves every terrain group, and
it is **build-asserted** that no dressed cell is in any other group. the_game:
3,509 faces.

### ground grooming — a speck is not a place, a hole is not terrain

`groom()` runs before anything is built (after `i2_systems`) and `regroom()`
again after every pass that paints ground; `audit_ground()` asserts at the end
of the build. Four rules, all from one round of photographs (maintainer
2026-09-05):

- **No speck.** A patch of natural ground (`NATURAL`: grass, mud, rocks,
  snow, ice, sand) of `SPECK_MAX = 2` cells or fewer, by ground alone, takes
  the ground most of its rim is — same level counted double — and failing a
  natural rim, whatever dry non-floor ground surrounds it (a mud dot in a
  road becomes road). A one-cell islet with a wet rim stays an islet. The v2
  port carried 65 lone grey_stone cells and 28 lone sand cells, one per
  terrace corner, each drawing its own top AND its own wall column; the
  terrace colouring and the road widening painted a few more, so
  `TERRACE_MIN = 6`: a terrace smaller than that never recolours.
- **No pocket.** A land or water patch of `POCKET_MAX = 60` cells or fewer
  whose whole rim stands `POCKET_DROP = 2` levels or more above it rises to
  the rim's lowest level; land takes the rim's ground, water stays water — a
  pond at the meadow's own level is a place to swim, a shaft is a trap
  (*"holes the player get stuck inside if they fall in"*). Iterated: a bowl
  filled can sit in a bowl. A patch a ramp reaches is a landing, not a hole.
  The mountain cut removes some pockets' only exit, hence the late pass.
- **Deep water is the sea.** Every liquid body but the largest is a pond, and
  a pond is `water` (*"The deep ocean tile is meant as an edge-of-world
  tile"*). Three ponds shipped as deep_water.
- **A bridge is built.** Bridge decks are `parquet_floor` (the pier's own
  planks, one course of face) below `BRIDGE_HIGH = 14` and
  `grey_paving_stone` above; the ported decks carried whatever v2 material
  lay under them — a slab of 100% grass, with mud on one bank and soil on
  the other. Both banks take the road for two cells at the deck's level.

### lava — with the black rock

Maintainer 2026-09-06: *"both slime and lava have never been used ... Lava
feels best together with black_rock. So maybe we need some lava on top of
the mountain. Again no hard rules. This game can combine anything with
anything, some placements/combinations should just occur more often than
others."* `lava()` (after the terrace colouring, which decides which shelves
are black rock): every black_rock terrace of `LAVA_MIN = 40` cells or more at
`LAVA_LEVEL = 20` or higher gets a pool, one more per `LAVA_PER = 200`
cells, each a blob of 3–7 cells whose every cell has its whole 5×5 square in
the shelf, pools 2 cells apart, clear of roads (and 2 cells beside them),
ramps, decks, houses, caves and the wild. **Lava is solid in the game**
(`surfaces.ts`, "deadly later; impassable for now"), so it is not a place to
stand in the reachability audit, and a pool ringed by walkable rock never
cuts a way. the_game: 31 lava cells in six pools on the level-24 shelf.
`lava` and `slime` are in the legend and are NOT liquids (`liquids` stays
water and deep water: the game decides what a ground does).

### the cave — dug, not inherited

Maintainer 2026-09-06: *"the cave floor should be dark_mud and the inside
wall should feel less random ... the floor and walls inside the cave is a
consequence of the top of the mountain and have not been thought through
... make the corridors a bit wider (maybe 1 cell) ... the scenery feels a
bit random."* The 12 ported cave lids kept the mountain's own top as their
floor (snow and ice floors underground) and their inner walls took whatever
pool the terrace above happened to draw.

`caves()` (right after `i2_cave`): every cave floor cell is **dark_mud**.
**THE WALLS ARE CHOSEN FOR THE CAVE, NOT READ OFF THE MOUNTAIN TOP**
(maintainer 2026-09-06: *"This is inside the mountain and we can have any
floor/ground type on the top regardless of what walls we use inside the cave
... We should pick walls that look good in the cave and not 'just use'
whatever the top of the mountain said"*; a first cut took the lid's ground,
and read as a coincidence). Caves whose floors touch are ONE complex, and a
complex is dug through one rock — `CAVE_ROCK`, grey stone or black rock,
drawn by the complex's own hash — with the one exception a designer makes on
purpose: in a complex of `CAVE_ICE_MIN = 4` rooms or more, the deepest lid
level is the **ice chamber**, every lid at that level, walls AND floor (a
chamber is several lids where the ported cave stepped; one lid in ice looked
like half a room). **Slime** lies on the floor somewhere: one pool per
`CAVE_SLIME_PER = 4` rooms of a complex, in a room that is neither ice nor
the biggest hall, a blob of 3–5 interior cells ringed by floor
(`_pool_blob`), walkable (the game classes slime as plain ground). `cliff_faces` gives a face whose foot
is a cave floor that side and no other; the mountain top and its outer walls
are untouched (the_game: one complex, black rock throughout, the level-40
chamber in ice). The cap tile of an inner wall (`<top>__over__<side>`) still
carries the mountain's top ground — that band is the tiles/game contract, not
a world channel. **Corridors are one cell wider**: every passage grows one
cell on its east/south side, into rock at the lid's level that is interior
on all eight sides, never into the mountain's shell — and a one-cell wall
between two passages goes with it (maintainer 2026-09-06: *"as soon as you
enter the cave you have two small corridors going top right instead of one
bigger corridor"*; the_game: 598 floor cells, 126 added). **A ROOM is where
the floor runs `ROOM_MIN = 4` or more through a cell both ways**
(`_cave_rooms`); anything narrower is a corridor and nothing is ever put in
it — the braziers included, which used to land on any floor cell (*"you
have blocked the corridors and made it even more hard to navigate the
dungeon"*). A two-cell passage counted as a room before.
`put()` refuses anything but cave dressing (`CAVE_OK`) on a cave floor — a
gate that sits AFTER the indoor test and its roof-shadow `else`, not between
them: the first cut split that `if`/`else`, the shadow rule ran on every
indoor placement, and every house shipped empty for three builds
(maintainer 2026-09-06: *"Was it you who removed all indoor scenery objects
from this house?"*). **Build-asserted now: a furnished room is never empty**,
and `put()` counts every refusal by reason in the build log.

`cave_dress()` (after `nature`): one piece per `CAVE_DRESS_PER = 7` cells of
a ROOM (a floor cell with five or more floor neighbours that is not a
corridor), `CAVE_GAP = 3` cells apart: crystals, geodes, fungi, mushrooms,
cairns, stones, skulls, gravel, puffballs, and frost flowers and a frozen
spring in the ice chamber. **Against the walls** (maintainer 2026-09-06:
*"you often place stuff in the middle of the room ... Why not place the
scenery against the walls more often?"*): a piece on a room's edge cell is
put FLUSH, its footprint's back edge on the wall line, the way furniture
meets a house wall — north and west walls first, whose faces show — and
about one piece in five stands in the open, one cell in from the wall. One
dragon ribcage in the biggest hall. Three braziers per room, flush against
the wall like the rest (`_put_flush`; a brazier on the wall side at the cell
centre reaches into the wall cell and the footprint law refuses it: 0 of 12
landed).
**THE CLIFF FAMILIES (`cliff_*`: roots, vines, mosses, fragments, features,
shrubs) ARE NEVER PLACED** — build-asserted. Maintainer 2026-09-06: *"You
should not use the scenery type 'Mountain wall', we will use that scenery
later, but that scenery will need training to use right. They are like
windows — you are not ready to use them yet."* the_game: 29 pieces of 9
kinds, plus 19 braziers.

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
true the moment a house is not made of wood. **`indoor_floors()` is the one
definition** every pass uses — the recorded cells PLUS anything under a
roof/cave deck, below it, wall-free and of an indoor material, which is how the
v2 island's ported houses qualify. Reading only the recorded half emptied
them: the furnish pass flooded and found nothing, so the fisher's house shipped
with a bush in it and no furniture (*"Why did you remive the furnitures in the
house and replaced it with a bush?"*). Nothing outdoor may stand on an indoor
floor, and the gate is in `put()` rather than a sweep afterwards, because the
sweep runs before `nature` plants anything.

**A HOUSE IS SITED, NOT DROPPED** (maintainer 2026-09-05: *"Why do you place
the house so close to the hill. Feel the balance please... Is the door placed
at a smart location? Is the house built at a smart location."*). A pad that is
flat in itself can still have a cliff against its back wall, and then there is
nowhere to stand and the hill grows out of the roof. `find_pad` now demands an
**ELBOW of 2 cells of same-level dry ground on every side**, and that **at
least one front face has a 4-cell walkable approach** — the ground a player
walks up to the door on. `house()` then puts the door on a side that passed and
**asserts the approach**, because a doorway opening onto a drop is a house you
cannot enter (*"How do you expect a player to even get in?!"*).

**THE DOOR IS NOT ALWAYS ON THE SAME WALL.** South is the screen's bottom-LEFT
face and east its bottom-RIGHT; both are front walls the camera sees and a
player can reach, and houses alternate between them (*"I see you also always
place the door at the bottom left and never bottom right"*). North and west
open into the back of the house, which the camera never shows — they are not
candidates.

**AN ART MAY NOT HANG OVER A DROP.** The footprint law refuses a footprint that
SPANS a level change; a rowboat whose footprint sat wholly on a ledge still
hung its art out over the cliff (*"Why did you place the boat on the wall?"*).
So the drawn sprite gets its own test: its two horizontal extremes, projected
onto the ground it stands on, must be cells at the same level and the same
wetness. Half the drawn width in cells is the reach (a screen offset of `dx` px
is `dx/64` of a cell in +x and the same in −y), capped at 3.

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

### lights — the town spends the whole budget, the woods keep one glow

(maintainer 2026-09-06: *"a single scene in the game should never show more
than 8 lights ... go all the way up to 8 at some locations and down to 1 or
even 0 at other locations ... streetlights next to the road ... lots of
small lights and some bigger ones"*.)

A light is a placement with `lit: true` and an explicit `state` (the
best-rated `LIT_*` state of the piece: the game draws that still and, from
games2's side, spends a shader slot with the state's `light` from
`scenery/<piece>/scenery.json` — strength, colour, radius; schema in
`scenery/README.md`, written by maps2, owned by scenery from here). The game
places its own campfire at spawn: it is one of the 8 wherever the spawn is,
and it is the reference — 1.0, radius 7, nothing outshines it.

**The budget is measured exactly** (`world3.light_boxes` / `max_overlap`):
a light of radius R cells is seen by every camera centre inside the 899×774
worst-case window grown by R·√2·32 px sideways and R·√2·15 px up-screen, so
the count at any point is the number of those boxes it lies in, and the
worst point is found by sweeping every box edge — not sampled at the lights'
own centres (the worst point is often a corner where nothing stands). The
audit asserts `worst ≤ 8` with the spawn bonfire counted; the placement pass
runs the same check incrementally on the box of the piece WHERE IT STANDS
after `put` snapped it (a probe at the asked position was a cell off and
blew the audit once).

**Placement is by what a place is, in priority, nearest-spawn first inside
a priority, and a candidate that would push any window past 8 is simply not
lit** (`world3grow.lights`, replacing the old greedy `relight`):

1. the plaza's corner streetlights and the village's lamps; every hearth
2. the beacon on Lighthouse Point — the one big far light (0.9)
3. two torch posts flanking the cave mouth, then the cave braziers hall by
   hall (one per hall, then a second; a hall's third comes after the cave's
   own crystals and fungi) — a first cut lit nine braziers in one cave and
   the mouth torches found no slot left
4. a lantern post beside every house door (on the hinge side of the step,
   else beside the path out from it — an east door's step sits in the roof's
   sideways `no_place` band), then the town's gate lanterns
5. streetlights every `LAMP_SPACING = 2.5` lamp radii of road (12 cells
   at radius 5) on a natural-ground cell beside the road, sides
   alternating; lit waystones between them at 1.6× that spacing. The
   spacing follows the lamps' published radius so a brighter lamp table
   thins the row instead of blowing the window.
6. **no place is pitch black** (maintainer 2026-09-06: *"some areas can't
   be completely black and some areas need even more light"* — and not
   evenly spread, that *"makes the entire game look the same"*): every
   reachable outdoor cell ends within `DARK_MAX = 12` cells of some pool's
   edge. The middle of the largest black patch (≥ `BLACK_MIN = 12` cells)
   gets a light that belongs to the place — a cauldron camp, charcoal kiln,
   giant mushroom, wayside shrine or ancient tree on the lowland; a crystal
   tree, rock spire, soulstone or crystal on the rock; a torch or a camp on
   the beach — until no patch is left. Pools stay islands with dark between
   them; only the pitch black goes. A patch nothing can stand in is given
   up; the build may leave `DARK_TOL = 3%` of outdoor cells black and
   asserts it.
7. forest glows: a lit mushroom or toadstool ring beside a reachable tree
   every `GLOW_EVERY = 20` cells (the glows come after the fill: a slot on
   a radius-2 mushroom is a slot a radius-5 camp could have lit the black
   with)
8. rock glows: a lit crystal on bare rock every `ROCK_EVERY = 24` cells,
   hash-jittered off the lattice

**Radius is the lever, not count.** A window is ~28×52 cells and holds 8
lights, so the share of any screen inside a pool is bounded by
8·π·R²/1450: ≤ 28% at radius 4, ≤ 85% at radius 7. At the published
radii (streetlights 3–5, glows 2) the night cannot be made bright by
placing more — a lamp row every 12 cells fills its windows and leaves the
land beside the road black — which is why the maintainer asked scenery for
2× streetlight radii (and half for rune stones). When that table changes
the world is rebuilt against it: the boxes grow, the row thins, the fill
reaches further.

Measured on the_game: 258 lit placements (crystals 47, streetlights 39,
crystal trees 29, cauldron camps 19, wayside shrines 17, charcoal kilns 16,
giant mushrooms 15, waystones 13, soulstones 12, toadstool rings 11,
mushrooms 10, braziers 7, lantern posts 7, torches 6, rock spires 4,
ancient trees 2, hearth 1, beacon 1), worst window 8/8. Outdoor reachable
cells: 12% inside a pool, 34% within 3 cells of one, 39% at 4–7, 12% at
8–11, 2.1% black (the level-12 terrace south of the mountain, whose
windows the town and its road row already fill). Camera spots sampled
every 4 cells: 8 lights 2%, 7 9%, 6 17%, 5 21%, 4 24%, 3 15%, 2 7%, 1 2%,
0 0%. The build log prints the tally, every refusal by reason
(`lights: black-patch fill refused (budget)`) and where each patch was
given up.

Only braziers that ship a LIT state go into a cave (`brazier_002` has none
and was a third of the cave's fires). Flicker is deferred (maintainer: "not
now"); `hearths`/`braziers` keep their slot even under a roof — indoor mode
(games2) decides what an under-roof light does.

### `ramps` — the contract with the game

A level change is a cliff. A **ramp** is where the world says a climb is
legal, so the game does not have to infer one from the heightfield.

* `cells` is an **ordered, 4-connected run**, foot first. Between any two
  consecutive cells the level differs by **exactly 1** — build-asserted.
* `from` / `to` are the levels of the first and last cell. A run is
  **monotone**: a chain that rises then falls is published as two runs.
* The rule the game implements (games2 `WALK_CLIMB = 1`, `JUMP_CLIMB = 2`):
  a **1-level step walks**, a **2-level ledge needs a jump**, 3+ levels is a
  cliff, and **dropping is always free** at any depth (fall damage from 6
  levels, the navigation line). A ramp is a chain of 1-level steps the
  renderer may dress as a slope; entering or leaving a ramp end from a
  same-level neighbour is ordinary movement, no special case.
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

### reachability — nobody gets stuck

Maintainer 2026-09-05, seven photographs from the massif and a wall: *"So I
jumped down and now I'm stuck. I can't get back up by going back and I can't
jump down to the unwalkable area ... Why can't you when building the map try
to see if you are stuck on this location or not? Do we need a ramp maybe?"*
and *"it would be really nice with a way to get up on the grass."*

**THE MAP IS BUILT ON REVERSIBLE MOVEMENT.** A move is reversible when the
player can take it back: a step of at most `CLIMB = 2` levels either way, or
a stair. `reach_audit()` (after the ramps, before scenery is policed) walks
the whole standable world from the spawn twice — once with free drops, once
with reversible moves only — and every cell in the first set but not the
second is a **trap**. A search that finds "a way out" is not the test: the
massif's snow rim had one, a 24-level fall 120 cells along the rim (measured
before this rule, 17,501 trap cells — the whole front of the massif was a
one-way cascade of 4-level shelves).

A stair climbs at most `STAIR_MAX = 8` levels — taller is a mountain, and a
mountain is climbed where the terrain offers it, never by a ladder (one
build laid a 31-cell staircase from the valley at 2 to the snow rim at 32:
*"WTF is this gigantic rectangle"*). **A STAIR IS A BREACH, CUT DOWN INTO THE
TERRACE ABOVE, NEVER BUILT UP OUT OF THE TERRACE BELOW** (`_stair`): `H − L − 1`
cells of the upper terrace, straight in from the cliff edge, become one step
each, `BREACH_WIDE = 3` lanes side by side where the plateau has room (two,
then one), and the plateau cells beside every step drop to two levels above
it so the cut flares into a gully rather than a slot. Each lane is a run in
`ramps[]` under the contract above. Steps raised out of the lower terrace —
freestanding blocks, a wedge hugging the wall — were built and rejected
(maintainer 2026-09-05: *"super thin ... just feels placed to solve some
rule ... Have you ever seen triangles like this in nature?"*). **Roads,
ramps and the cells beside them, houses and the wild are never carved**; a
stair that would need them is not built, and a trap under `LEDGE_MAX = 12`
cells with no room joins the terrace above. **The road is never broken**:
every two adjacent road cells differ by at most one level, as `ramps()` left
them — asserted, because one build cut stairs across the Trollstigen
switchbacks and the old road could not be climbed. Trap components are
fixed in rounds (a trap whose only way out is another trap waits for it),
one breach per `STAIR_EVERY = 24` cells of a component's edge.

**A WALL IS NEVER THE END OF THE WALK.** After the traps, every cliff of 3
to 8 levels between two terraces the player walks on has a stair within
`STAIR_EVERY` cells along it (natural ground both sides, never a house, a
floor, a road or water), swept twice because a stair makes new terraces
reachable. **A slope that invites you up arrives**: a cell at the top of a
run of 1-level steps under a cliff of 3+ levels gets a notch cut down into
the terrace above whatever the spacing rule says and whether or not anyone
can reach that terrace yet (maintainer at (352,416), a slope 4..9 under a
plateau at 12: *"lower the cliff around the place where you make the
ramp"*). **Unreachable land is joined**: any patch of 8+ land cells nobody
can reach at all gets a stair from the nearest reachable terrace wherever
the cliff between them is 8 levels or less; house walls and the wild are
unreachable on purpose, and island 2's summit (22+ levels above everything)
waits for a serpentine. the_game: 41 breaches for traps, 45 along cliffs,
5 joining unreachable land, 185 lane runs, **0 traps left — build-asserted**, and the ramp contract is
re-asserted over every run.

Bridge decks are standable at their own level; roof and cave decks are
not (the ground under them is). Water is swimmable at its level and climbed
out of like any step, so a shore over 2 levels is a wall and gets its stair.
Deep water is not a place to stand: the current owns it.

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

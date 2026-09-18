# Ambient zones — `pixel-maps3/ambient@1`

**Every ambient effect belongs to a place, with a share.** maps2 places the
zones; the game's SERVER decides, per zone, what is on and tells every client
in it, so all players in a place see the same rain (maintainer 2026-09-18:
*"the entire ambient-effect system should be tied to zones you control ...
ambient effects are no longer turned on/off randomly. Instead the place a zone
and a % how often this effect should be active in this zone ... controlled by
the backend server and not the client"*). Every world ships
`maps2/worlds3/<name>/ambient.json` next to its `world.json`; the game reads
it the way it reads `spawns.json` (`readWorldDoc`).

```jsonc
{
  "schema": "pixel-maps3/ambient@1",
  "world": "the_game",
  "size": 394,                                  // the grid; the world zone is [0,0]-[size,size]
  "exclusive": [["drizzle","rain","heavyrain","storm","snow","windy"],
                ["birds","bats"], ["fireflies","pollen"]],   // informative: games2/ambient's own table is the truth
  "zones": [
    {"id": "world", "name": "The whole world", "kind": "world",
     "area": [[0,0],[394,0],[394,394],[0,394]], "cells": 155236,
     "effects": {"foam": 100, "water": 100, "deepwater": 100, "lava": 100, "drips": 100,
                 "dust": 100, "embers": 100, "smoke": 100, "chimney": 100, "moths": 100,
                 "feathers": 100, "fish": 100}},
    {"id": "marsh-the-western-marsh", "name": "the western marsh", "kind": "marsh",
     "area": [[131,246],[133,246], ...],         // spawns@1 polygon: tile corners, axis-aligned, simple
     "cells": 2195,                              // how many cell centres it holds (informative)
     "effects": {"dragonflies": 100, "gnats": 85, "fireflies": 90, "drizzle": 25, ...}},
    {"id": "cave-pit-i", "name": "Pit I", "kind": "cave", "elev": [4, 6], ...}
  ]
}
```

## The contract

- **`area`** is the `spawns@1` polygon (`SPAWNS.md`): tile-corner vertices,
  every edge axis-aligned, no self-intersection (generator-asserted), the
  polygon closes implicitly, and a cell is in the zone when its CENTRE is
  inside (even-odd). A player is in the zone when the cell under them is.
- **`elev`** (optional, `[lo, hi]`, inclusive levels) says which SURFACE the
  zone means where surfaces stack: a cave zone is its floor's levels, not the
  mountain over it; the slime pools are underground. No `elev` = any level.
- **`effects`** maps an effect NAME to a **share, a whole number 1..100: how
  often the effect should be active in this zone** (a target duty cycle over
  time, not an intensity). Names are `games2/ambient`'s feature folders plus
  the six weather rows (`drizzle rain heavyrain storm snow windy`); the gate
  refuses a name the game does not register.
- **Zones overlap, on purpose.** At a point, for each effect the SERVER takes
  the largest share any zone there gives it. For effects that cannot run
  together (`exclusive`: one weather at a time; birds/bats; fireflies/pollen)
  the shares at that point are the WEIGHTS of the draw — a place under
  "the wet west" (rain 18) and "the mountain weather" (snow 35) snows about
  twice as often as it rains — and the group's total on-time is the sum of
  its shares, capped at 100; what is left is clear. Where two overlapping
  zones both say rain, rain is not doubled: max, then the draw.
- **The zone says WHERE and HOW OFTEN; the effect keeps its own gate** — a
  firefly zone at 90 means 90% of the NIGHTS, butterflies still want sun and
  grass, crabs still want a beach under them. A share never forces an effect
  onto ground it does not draw on.
- **The `world` zone** covers the whole canvas at 100 for the effects that
  find their own object or surface — foam and water (his words), deep water,
  lava, drips, dust, embers, smoke, chimney, moths, feathers, fish. Each is
  nothing without its fire, lamp, shoreline, pool or cave, so the map is its
  zone. It carries NO weather (gate-asserted) — weather is always a place.
- **Server-driven**: the server rolls per zone (an epoch of minutes, the
  games agent's number), and a change reaches every client in the zone at
  once. The client never rolls. `kind` and `name` are for the page and the
  logs; the server keys on `id`.

## How the zones are placed (`maps2/pipeline/ambient.py`)

**Read off the terrain, never drawn by hand**, so a rebuilt world places its
own zones: the sea in four quarters around the island (each a hole-free
piece); the shore (land within three cells of salt water); the dunes (the
big sands); the lakes and their banks, and the tarns up the massif; the marsh
(low dark mud and the reed beds); the meadows (low grass that is neither
wood nor street); the woods (four trees or more in a 9x9 window); the high
pasture (grass up the terraces); the massif (rock, snow, ice and mud from
level 14) and its summits (snow and ice from level 30); the lava field; every
cave from `places.json` at its floor's levels; the town, the village and the
lone cottages (a house and the paving AMONG houses — a road is not a town);
the slime pools (underground); each islet by its ground (Lighthouse Point,
the standing stones, the shoal, the fen). Pieces of one kind are named by
the game's compass from the island's middle (north is the low x+y corner).

**The weather provinces are the one hand-placed thing** (`PROVINCES`): five
ellipses — the wet west, the northern sun, the eastern shore, the southern
rains, the mountain weather along the massif — because where it rains is a
choice the ground cannot make, and it has to differ across the map or the
map is one place. They overlap, and the overlaps are the weights.

**Shape law**: a mask with a hole is split along the hole's median row into
two TOUCHING pieces (no cell is lost to the cut) until every piece is
hole-free, then each 4-connected piece is diagonal-cleaned, traced and proved
simple with the spawn zones' own code (`spawns.py`). Small holes (<= 500
cells) are filled: the effect self-gates on the ground anyway.

**Gate** (`--check`, also the last step of `world3grow.run`): every polygon
simple; every effect name registered; every share a whole number 1..100;
every registered effect placed somewhere; every land cell inside a region
(a thousandth of the land may be specks the smoothing dropped); every land
cell under a zone that carries weather; the world zone carries none.
`--apply <world_dir>` derives and writes; `--page <world_dir> <out>` renders
the review page (the minimap with every zone drawn over it at the ground's
own level, tap a zone, filter by effect) — the page linked on every change.

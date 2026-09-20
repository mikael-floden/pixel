# Ambient zones — `pixel-maps3/ambient@1`

**Every ambient effect belongs to a place, and a place has ONE.** maps2 places
the zones; the game's SERVER decides, per zone, what is on and tells every
client in it, so all players in a place see the same rain (maintainer
2026-09-18: *"the entire ambient-effect system should be tied to zones you
control ... the place a zone and a % how often this effect should be active
in this zone ... controlled by the backend server and not the client"*).
Every world ships `maps2/worlds3/<name>/ambient.json` next to its
`world.json`; the game reads it the way it reads `spawns.json`
(`readWorldDoc`).

**A place is remembered by one effect** (maintainer 2026-09-19, on the first
cut, which gave every place of a kind the same eight effects at middling
shares under five weather ellipses: *"you have no feeling at all and just
created lots of areas and randomized what happened inside them ... The
ambient effect should help the player to remember a place by adding effects
the player might have never seen before. This makes each place special ...
the rain that almost always is present at this location. I SAID ALMOST
ALWAYS ... Always leave a small door open to something weird and it will do
more good than bad"*). So every zone carries a **signature** at 90 — the
sandstorm dunes, the crab beach, the village where it rains, the summit that
storms — a **support** or two at 20 or under that colour it and never compete
with it, and **doors** at 0.5, one window in two hundred, for the thing that
should not happen there: snow on the meadow, rain on the summit. Weather is a
place's signature or a door, never a blanket: there is no weather province.

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
     "cells": 2285,                              // how many cell centres it holds (informative)
     "effects": {"fireflies": 90, "gnats": 15, "snow": 0.5, "storm": 0.5}},  // signature, support, doors
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
- **`effects`** maps an effect NAME to a **share: how often the effect should
  be active in this zone** (a target duty cycle over time, not an intensity)
  — `0.5` is a door (one window in two hundred), else a whole number 1..100.
  Names are `games2/ambient`'s feature folders plus the weather rows the
  game itself lists (`games2/shared/src/ambient.ts` `WEATHER_EFFECTS` — eight
  today: `cloudy mist drizzle rain heavyrain storm snow windy`; the generator
  reads that list, never a typed copy: a typed six missed `cloudy` and `mist`
  for a day); the gate refuses a name the game does not register.
- **One signature, supports that never compete, a door.** Exactly one effect
  of a zone is at 85 or more (`SIGNATURE` = 90); every other whole-number
  share is at most `SUPPORT_MAX` = 20 and never in the signature's exclusive
  group (it would eat the signature's windows); at least one effect is a
  door. A cave or slime zone has one door and it is cave life; every other
  place has two, weather first. (Gate-asserted, all of it.)
- **Surface zones do not overlap.** A cell belongs to the most specific place
  standing on it, so at a point there is one place and one server window —
  the server's max-share rule for overlapping zones (`games2/docs/ambient-
  zones.md`) is only ever exercised where a cave lies under the mountain zone
  above it, and there the cave's own `elev` band keeps the two apart on the
  surface. Two neighbouring places (any kind, piece centres within `NEAR` =
  40 cells) never share a signature; the pieces of one place split along a
  hole share its name and its signature.
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
own zones — **in precedence, the most specific place first, each taking its
cells out of every place after it**: each islet by its ground (Lighthouse
Point, the standing stones, the shoal, the fen), whole with its water rim;
the slime pools where they lie open at the surface (underground otherwise);
the dunes (the big sands); the lakes and their banks, and the tarns up the
massif; the lava field; the summits (snow and ice from level 30); the town,
the village and the lone cottages (a house and the paving AMONG houses — a
road is not a town); the marsh (low dark mud and the reed beds); the woods
(four trees or more in a 9x9 window); the high pasture (grass up the
terraces); the meadows (low grass that is neither wood nor street); the
massif (rock, snow, ice and mud from level 14, around its summits); then
what the named kinds leave, by its own ground — the sands (a beach under a
cliff), the moor (the high mud plateaus), and the heath, named by what it is
made of (the western rocks, the eastern slime, the south-eastern green); the
shore (what is still nobody's within three cells of salt water); the sea in
four quarters around the island; every cave from `places.json` at its
floor's levels, under the mountain. A scrap too small to be a place (under
`MIN_PIECE`, 120 for the catch-alls) joins the place it touches along most of
its rim. Pieces of one kind are named by the game's compass from the
island's middle (north is the low x+y corner).

**The signatures come from a palette per kind** (`PALETTES`, the one
hand-written thing): kinds pick in `KIND_ORDER` (the same precedence) and
each kind's places largest first; a place takes the palette entry that fits
its ground (`needs`: crabs want sand under them, butterflies grass — the
effect keeps that gate in the game, and a signature that could never draw is
not one), is not a neighbour's, has signed the fewest places of this kind,
and has not yet signed `CAP` = 4 places anywhere — so the dunes are the
sandstorm before anything else is, the town has the birds and the village
the rain, the places of a kind differ from each other, and every effect is
somebody's before any is somebody's fifth. The supports ride the entry; the
doors come from `DOORS` by kind (what should not happen here, first).

**Shape law**: a mask with a hole is split along the hole's median row into
two TOUCHING pieces (no cell is lost to the cut) until every piece is
hole-free, then each 4-connected piece is diagonal-cleaned, traced and proved
simple with the spawn zones' own code (`spawns.py`). Small holes (<= 500
cells) are filled: the effect self-gates on the ground anyway.

**Gate** (`--check`, also the last step of `world3grow.run`): every polygon
simple; every effect name registered; every share a door or a whole number
1..100; every registered effect placed somewhere; one signature per zone,
supports at most 20 and outside its exclusive group, a door left open; no
province; every land cell inside a place (a thousandth of the land may be
specks the smoothing dropped) and under at most one surface place (a
thousandth of the land may be a trace's corner cell); two neighbouring
places never share a signature; the world zone carries no weather.
`--apply <world_dir>` derives and writes; `--page <world_dir> <out>` renders
the review page (the minimap with every zone drawn over it at the ground's
own level, tap a zone, filter by effect) — the page linked on every change.

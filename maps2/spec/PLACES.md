# Named places — `pixel-maps2/places@2`

A place is a named **REGION**, indoors or out, so the game can react to a ROOM
— fire an enter/exit event, bind music — instead of re-deriving geometry.
(maintainer: name each "in-door" so a sound can trigger on entering; and
"we might want different named zones for outdoor as well… We need a zone for
`mountain_top`"). @1 derived places from roof/cave decks, so only an inside
could have a name; @2 dropped that assumption and added the field outdoors
makes necessary, `elev`.

Every world ships `worlds/<name>/places.json` beside `world.json`,
`spawns.json` and `npcs.json`.

## The file

```json
{
  "schema": "pixel-maps2/places@2",
  "world": "the_island2",
  "places": [
    {"id": "stone_house", "name": "The Stone House", "kind": "house",
     "indoor": true,  "elev": [0, 0],   "anchor": [200, 115],
     "cells": [[198,113], [199,113], "…"]},
    {"id": "mountain_top", "name": "The Mountain Top", "kind": "summit",
     "indoor": false, "elev": [16, 40], "anchor": ["…"],
     "cells": ["…"]}
  ]
}
```

| field | meaning |
|---|---|
| `id` | **the event key.** Stable, snake_case, unique within the world. Once the game binds to it it does not change — a rename is a new place. |
| `name` | display name, for UI and the wiki. May be rewritten (lore owns the vocabulary); never bind to it. |
| `kind` | `house`, `cave` or `summit` — what *sort* of place, so a consumer has a sensible default before anyone hand-binds this particular id. |
| `indoor` | whether you are under a roof in here. Derived, so a consumer needs no kind→indoor table. |
| `elev` | `[min, max]` **surface** levels — the band the player's own `elev` must fall in. Not decoration: see *The stack*. |
| `anchor` | one cell inside the place, nearest its centroid. For map pins and debug, not for containment. |
| `cells` | the footprint. **Cell → place is one lookup**; no geometry needed on the consumer side. |

`places: []` is normal — a flat showcase map has neither an inside nor a
summit.

## The stack — why a cell alone is not an answer

`the_cave` and `mountain_top` on `the_island2` share the cave's entire 472-cell
footprint: the cave floor (elev band `[0,0]`) lies directly under the
black-mountain rock at 32-40, with the snow cap over both — one is a dungeon,
the other a summit. A consumer therefore resolves **(cell, the surface the
player is standing on)** — exactly what `Player.elev` already carries and what
`spawns@1` has banded since the water law.

Two places may share cells. They may never share cells **and** an overlapping
`elev` band, and the build asserts it — a player is never in two places at
once, so the lookup always has one answer.

## Consumers (live)

- The client loads `places.json` with the world (un-awaited; a world without
  one is normal — every cell reads as outdoors) and builds the
  `(cell, elev) → place` lookup (`WorldScene`, `PlaceLookup`).
- For an `indoor` place the answer is gated on the indoor state machine that
  already runs: being over a roofed cell is not the same as being inside, and
  `findIndoorSpace` (`games2/shared/src/indoor.ts`) is the authority on that.
  An outdoor place needs no gate — standing on the ground is the whole test.
- The composer binds music per place id: `PLACE_BEDS` in
  `games2/composer/engine/api.ts` (e.g. `the_cave` → the cave4 bed; a place bed
  owns the music bus while set). Keyed on the **id**, deliberately not the
  `kind` — two caves can want different music. Adding a room's music is a line
  there plus a track; nothing in the map needs to change.

## Where the names come from

**Canon wins where canon has a name.** `lore/canon/GLOSSARY.md` is the
controlled vocabulary and `lore/canon/CONSTRAINTS.md` §5 lists the map features
lore treats as named — "use the names, never the positions". Adopted verbatim
on `the_island2`:

- **The Stone House** — GLOSSARY, *the Waking*: you wake "within sight of
  **the stone house** and the fire". The cottage at the arrival point.
- **The Cave** — CONSTRAINTS §5 and the red line use *the cave* as a proper
  name: the one dungeon the whole world is afraid of.

Only the maintainer's second house had no canon name and got a plain
descriptive one — **The Meadow House** — rather than an invention. maps2 owns
its entities' text and lore fills the gaps, so lore may replace any `name`
here; the `id` is what the engine binds to and it will not move.

## Places are DERIVED, names are looked up

The standing doctrine (rules, never spot edits) applies to the geometry:

1. every `roof`/`cave` deck is grouped into **8-connected** footprints — a
   point-touch is a visible seam, not a second building, and the cave's stacked
   slabs are one place (`bridge` is excluded: a span is a roof over open air
   and the game calls it outdoors);
2. a group containing any `cave` deck is `kind: "cave"`, otherwise `"house"`;
3. every OUTDOOR rule runs over the terrain (today: the summit, below);
4. each result gets a **role** computed from `world.json` alone — `house-1` is
   the house nearest the arrival point, `house-2` the next, `cave-1` the cave,
   `summit-1` the mountain top (ties on the lowest cell, so a rebuild is
   reproducible). Keying on the role and never on a coordinate is what makes a
   name survive the terrain moving;
5. `places.NAMES[world][role]` supplies the id and display name.

Re-derived by `save_world` beside spawns/npcs.

### The outdoor rule: `mountain_top`

The zone is **THE MASSIF**, not just the cap (maintainer, standing at surface
17 on the grey benches: "I want the mountain top to start when the player have
almost climbed it and are kinda at the top"). Found from the top, grown down,
stopped at the foot — every step measured off the terrain, no magic number:

1. **The snow line.** Walk *down* from the highest populated surface level
   while each level's land is still mostly snow/ice; stop at the first that is
   not. On `the_island2` that is **bench 28** — 98% snow at 28, 0% at 27 — the
   boundary the tiles themselves draw. No per-world tuning (`the_island` 24,
   `demo_isle` 7, `demo_lost` 8), and every flat showcase map gets **no summit
   at all**: its snow and ice are tile *samples* at level 0, and a snow line at
   level 0 is not a mountain.
2. **Grow down through mountain GROUND** (stone, obsidian, snow, ice), not by
   level — what separates the massif from the high **grass** plateaus sharing
   its benches (bench 20 is 58% meadow; no level-only rule can tell the West
   Plateau from the mountain's shoulder).
3. **Stop at the foot** — one bench below the massif's lowest *real* bench,
   where "real" is relative to *this* mountain (≥ `BENCH_FRAC` of its biggest
   level). One bench below keeps the **cut-in ascent ramps** — the climb — and
   drops the toe running to the sea.

On `the_island2` the benches come out 20/24/28/32/36/40, so the foot derives to
**16** — exactly where the generator puts the massif floor. (Not tuned to
that; it landed there, which is the check that it measures something real.)

Result: **7,309 cells, elev 16-40** — snow cap, grey benches, the ascent onto
them, and both flanks of the gorge (the top of a mountain does not become a
different place because a canyon splits it, and a song should not stop because
you crossed a bridge). Zero cells below the maze cap, so the mountain music can
never play on a rock at the shoreline.

Rejected statistics — recorded so nobody re-derives them:

| tried | what went wrong |
|---|---|
| fixed drop from the peak (`max − 8`) | reads the whole of a shallow world as summit |
| *cumulative* snow fraction | crossed its threshold by 0.06% and swept in 2,780 cells of meadow |
| *absolute* bench-size floor | elected 60 cells of coastal rock at level 1 as the bottom bench, leaving the foot at 0 |

## The gate

```
python maps2/pipeline/places.py --check      # exit 1 on any violation
```

Two properties a consumer relies on:

- **every inside is named** — a roofed cell belonging to no place fails the
  build (a player can walk in there and the game has nothing to fire), so a
  world that grows a new house cannot ship it anonymous. Outdoor coverage is
  deliberately NOT required: unnamed ground is just outdoors.
- **every named cell still exists as it was named** — an indoor cell must still
  be under an indoor deck (a building that moved cannot leave the event firing
  over open grass), an outdoor cell still land, not water or void.

Plus: ids unique, anchor inside its own place, and **no cell in two places at
an overlapping elevation** — the assert that makes the stack safe.

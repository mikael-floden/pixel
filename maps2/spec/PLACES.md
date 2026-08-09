# Named places — `pixel-maps2/places@2`

> "Can you give the 'in-door' on each map a name so we can trigger a sound when
> someone walks into that exact house/dungeon/cave etc. The game engine will
> then fire an event on entering this in-door place and we can bind music to
> it. Can you give the different in-door locations a logical name? Does a name
> like that already exist?" — maintainer, 2026-08-08

> "Let's say we want to give the top of the mountain a song triggered by your
> `mountain_top` name/id. That is outdoors, but we might want different named
> zones for outdoor as well. Do we support that now? If not add support for it.
> We need a zone for `mountain_top`." — maintainer, 2026-08-08

**Did a name already exist? No — but the vocabulary did.** Nothing in the map
data, the game or the score identified one inside from another; what already
existed was lore's canon, which had names for two of the three insides on
`the_island2` and no way to attach them to geometry. See *Where the names come
from* below.

**@1 → @2: outdoors.** @1 derived places from roof/cave decks, so an inside was
the only thing that could have a name. @2 drops that assumption — a place is a
named **region**, indoors or out — and adds the field outdoors makes necessary,
`elev`.

Every world now ships `worlds/<name>/places.json` beside `world.json`,
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
     "indoor": false, "elev": [28, 40], "anchor": [76, 94],
     "cells": ["…"]}
  ]
}
```

| field | meaning |
|---|---|
| `id` | **the event key.** Stable, snake_case, unique within the world. Once the game binds to it it does not change — a rename is a new place. |
| `name` | display name, for UI and for the wiki. May be rewritten (lore owns the vocabulary); never bind to it. |
| `kind` | `house`, `cave` or `summit` — what *sort* of place, so a consumer has a sensible default before anyone hand-binds this particular id. |
| `indoor` | whether you are under a roof in here. Derived, so a consumer needs no kind→indoor table. |
| `elev` | `[min, max]` **surface** levels — the band the player's own `elev` must fall in. Not decoration: see *The stack*. |
| `anchor` | one cell inside the place, nearest its centroid. For map pins and debug, not for containment. |
| `cells` | the footprint. **Cell → place is one lookup**; no geometry needed on the consumer side. |

`places: []` is normal — a flat showcase map has neither an inside nor a summit.

## The stack — why a cell alone is not an answer

`the_cave` and `mountain_top` on `the_island2` **share 375 cells**. The cave
floor lies at elev 0-1 directly under the black-mountain rock at 32-40, with
the snow cap over both — one is a dungeon, the other is a summit you can see
the whole island from. So a consumer resolves **(cell, the surface the player
is standing on)**, which is exactly what `Player.elev` already carries and what
`spawns@1` has banded since the water law.

Two places may share cells. They may never share cells **and** an overlapping
`elev` band, and the build asserts it — a player is never in two places at
once, so the lookup always has one answer.

## What the game already had, and what was missing

- **world@2 decks** carry `kind` (`roof`/`bridge`/`cave`), material, level,
  thickness and cells — and no identity. Two houses are two anonymous roof decks.
- **The game decides indoors GEOMETRICALLY, per query.** `findIndoorSpace`
  (`games2/shared/src/indoor.ts`) flood-fills the roofed cells around you and
  measures how enclosed they are. It answers *"am I indoors"* very well and
  *"indoors **where**"* not at all: the space it returns has no id, and two
  calls from the same room return equal-but-unrelated objects.
- **The score has beds but no places.** `cave` and `home` exist in
  `games2/composer/engine/bedSelect.ts`, selected from continuous sensors
  (`BedInputs.cave` = how roofed-over you are, `fire` = how near the spawn
  bonfire). So every cave on every map is the same cave, and there is no moment
  of *entering* — it is a gradient, not an event.

The missing piece was identity, and it belongs to whoever makes the rooms.

## Suggested wiring (games2 + games-audio own the actual names)

maps2 ships identity; the event namespace is the game's. The shape that fits
what already exists:

1. Load `places.json` with the world; build `(cell, elev) → place` once (a
   `Map`, the way `roomCellMemo` is built from `space.roof`). A cell can carry
   two places at different bands — see *The stack* — so the player's `elev`
   picks between them.
2. For an `indoor` place, gate the answer on **the indoor state machine that
   already runs**: being over a roofed cell is not the same as being inside,
   and `findIndoorSpace` is already the authority on that. An outdoor place
   needs no such gate — standing on the ground is the whole test.
3. On a change, emit `gameAudio.event("place.enter")` / `"place.exit"` with the
   id, or a literal per place if the sound domain prefers literal names — the
   composer's rule is that a call site must carry a literal, so the audio agent
   should choose that shape.

Nothing here needs the map to change to add a sound: a new binding is a new
entry in the composer's assignment table against an id that already ships.

## Where the names come from

**Canon first.** `lore/canon/GLOSSARY.md` is the project's controlled
vocabulary and `lore/canon/CONSTRAINTS.md` §5 lists the map features lore
already treats as named — "their *names* have persisted; their *coordinates*
have not. Use the names, never the positions." Two of `the_island2`'s three
insides were therefore already named and are adopted verbatim:

- **The Stone House** — GLOSSARY, *the Waking*: you wake in the meadow grass
  "within sight of **the stone house** and the fire". That is the cottage at
  the arrival point.
- **The Cave** — CONSTRAINTS §5 and the red line both use *the cave* as a
  proper name: the one dungeon the whole world is afraid of.

Only the maintainer's second house (2026-08-07) had no canon name, and it gets
a plain descriptive one — **The Meadow House** — rather than an invention.
maps2 owns its entities' text and lore fills the gaps, so lore may replace any
`name` here; the `id` is what the engine binds to and it will not move.

## Places are DERIVED, names are looked up

The standing doctrine (rules, never spot edits) applies to the geometry:

1. every `roof`/`cave` deck in the world is grouped into **8-connected**
   footprints — a point-touch is a visible seam, not a second building, and the
   cave's twelve stacked slabs are one place;
2. a group containing any `cave` deck is `kind: "cave"`, otherwise `"house"`;
3. every OUTDOOR rule runs over the terrain (today: the summit, below);
4. each result gets a **role** computed from `world.json` alone — `house-1` is
   the house nearest the arrival point, `house-2` the next, `cave-1` the cave,
   `summit-1` the mountain top (ties on the lowest cell, so a rebuild is
   reproducible);
5. `places.NAMES[world][role]` supplies the id and display name.

### The outdoor rule: `mountain_top`

The summit is the ground at or above the world's own **snow line**, and the
snow line is *measured, not chosen*: walk **down** from the highest populated
surface level while each level's land is still mostly snow/ice, and stop at the
first level that is not.

On `the_island2` that lands on **bench 28** — at 28 the massif is 98% snow, at
27 it is 0% and pure grey stone. That is the boundary the tiles themselves
draw, so the zone comes out as the snow cap exactly: 5,604 cells, elev 28-40,
both flanks of the gorge (the top of the mountain is one place even where a
canyon splits it, and a song should not stop because you crossed a bridge),
stopping dead at the grey benches below.

It needs no per-world tuning: `the_island` 24, `demo_isle` 7, `demo_lost` 8,
and every flat showcase map gets **no summit at all** — their snow and ice are
tile *samples* at level 0, and a snow line at level 0 is not a mountain.

Two statistics were tried and rejected first, both worth not re-deriving: a
fixed drop from the peak (`max - 8`) reads the whole of a shallow world as
summit, and the *cumulative* cap fraction crossed its threshold on
`the_island2` by 0.06% and swept in 2,780 cells of meadow.

Keying on the role rather than on a coordinate is what makes a name survive the
terrain: a house that moves keeps its name, and a re-generated world needs no
edit. `bridge` decks are deliberately excluded — a span is a roof over open
air, and the game's own classifier calls a bridge outdoors however enclosed it
measures.

Places are re-derived automatically whenever a world is written (`save_world`
calls `places.refresh`, beside spawns and npcs).

## The gate

```
python maps2/pipeline/places.py --check      # exit 1 on any violation
```

Two properties, both of which a consumer relies on:

- **every inside is named** — a roofed cell belonging to no place fails the
  build, because a player can walk in there and the game has nothing to fire.
  A world that grows a new house therefore cannot ship it anonymous. (Outdoor
  coverage is deliberately NOT required: unnamed ground is just outdoors.)
- **every named cell still exists as it was named** — an indoor cell must still
  be under an indoor deck (a building that moved cannot leave the event firing
  over open grass) and an outdoor cell must still be land, not water or void.

Plus: ids unique, anchor inside its own place, and **no cell is in two places
at an overlapping elevation** — the assert that makes the stack safe.

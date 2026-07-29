# Monster spawn zones — `pixel-maps2/spawns@1`

maps2 owns the REAL monster spawn areas (maintainer 2026-07-29). The game's
rectangles clustered near the player spawn are explicitly fake debug areas
("later the maps agent owns real spawn areas", `games2/shared/src/monsters.ts`)
— this sidecar replaces them. Every world ships
`maps2/worlds/<name>/spawns.json` next to its `world.json`:

```jsonc
{
  "schema": "pixel-maps2/spawns@1",
  "world": "the_island2",
  "zones": [
    {
      "id": "cave-1",             // stable, human-readable (debug overlays, logs)
      "monster": "lava_poring",   // an id from monsters/config/roster.json
      "area": [[141,68], [144,66], ...],   // SIMPLE polygon (see below)
      "elev": [0, 1],             // the INTENDED walk surface (see below)
      "num": 8                    // monsters living in this zone
    }
  ]
}
```

## `area` — a real area

- Vertices are **tile-corner coordinates** (integers; cell `(x,y)` spans corners
  `(x,y)`–`(x+1,y+1)`), listed once — the polygon closes implicitly.
- Any shape is legal, **concave or convex**, but it must be a *real* area:
  **no self-intersections** (generator-asserted), axis-aligned edges (the
  generator traces cell-region boundaries; the format itself would allow any
  simple polygon).
- A zone's cells are the cells whose **CENTER lies inside** the polygon
  (even-odd rule).
- The area is where the monster **MAY** be. The game must validate every actual
  spawn/roam point (standable/swimmable surface within `elev`, no prop) — so a
  polygon may freely span the odd water speck, boulder or wall cell.
- Zones **may overlap** each other: different monsters share ground, and two
  zones can even cover the SAME cells at different elevations (see `elev`).

## `elev` — which surface is meant (caves & bridges)

`[min, max]`, inclusive, in world levels. A monster of this zone may stand at a
cell on whichever surface — **base OR deck** — has its walk level inside the
range. This single field disambiguates every layered case:

- **the cave** under the_island2's east mountain: floor zone `elev [0,1]`
  (base), while the snowfield zones above it ride the `kind:"cave"` roof decks
  at `[24,40]` — same cells, different zones, no ambiguity;
- **bridges**: a zone on the span uses the deck level (`[24,24]` for the high
  gorge bridge); the water below belongs to shore zones at `[0,0]`;
- sloping ground (a grass trail climbing benches) simply widens the range.

## `num` — population

How many of this monster live in the zone. The generator scales it with the
zone's cell count (`num = clamp(cells / density, 1, 12)`, density ~60 cells per
monster, water ~90) so a big area holds more monsters at the same density; the
game may treat it as the concurrent cap per zone.

## Generation (rules, never spot edits)

`maps2/pipeline/spawns.py` derives every world's zones from its `world.json` by
habitat rules — deterministic and idempotent (`python maps2/pipeline/spawns.py`):

| monster        | habitat |
|----------------|---------|
| poring         | open grass; plus one showcase zone on the biggest bridge deck |
| forest_poring  | grass within 3 cells of a tall grove prop (`base_x_4/5`) |
| ice_poring     | snow + ice — including the cave ROOF (its decks carry the surface) |
| lava_poring    | black_mountain rock, plus THE CAVE floor (`elev [0,1]`) |
| sand_poring    | beaches |
| water_poring   | water within 4 cells of land (shores, lakes, the tarn) |

Per habitat: 4-connected components ≥ ~30 cells (forest 12), biggest 4 kept,
each becoming one polygon zone (diagonal contacts healed so the traced boundary
is provably simple). Validation asserts every zone has at least `num` valid
standable cells at its claimed elevation before the file is written.
`monster_demo` is the exception: its builder (`monsterdemo.py`) writes explicit
pad zones (`BUILDER_OWNS` in spawns.py).

## The demo world — `monster_demo`

Like `prop_demo` demos tile props: one **5×5 pad per monster**, floored with
the tile that creature most likely lives on (water = a swimmable pond), on a
neutral stone courtyard so every pad — and therefore every spawn area — is
visible at a glance. Each pad is one zone (`num 2`, `elev [0,0]`), big enough
to watch the monster wander. Rebuild: `python maps2/pipeline/build.py
monster_demo`.

## Consumers

The game replaces `spawnAreasNear`'s fake rectangles by loading
`spawns.json` when present (worlds without one, or with `zones: []`, spawn
nothing). Point-in-polygon + the `elev` surface rule above; roaming stays
inside the polygon at the zone's surface. Until that lands, the fake
near-spawn rectangles remain — the data ships ahead of the consumer, like
world@2 decks did.

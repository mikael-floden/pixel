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
habitat rules — deterministic and idempotent (`python maps2/pipeline/spawns.py`).
`monsters/config/roster.json` is the monster-id authority and grows on its own
(the PixelLab MONSTER tag decides membership — 24 monsters today): every id maps
to ONE habitat key via `MONSTER_HABITAT` in spawns.py (`NAME_HINTS` guesses a
home for brand-new ids until the table is extended). Habitat keys:

| habitat | ground | residents (today) |
|---------|--------|-------------------|
| grass   | open saturated_grass | butterfly_dragon, saber_toothed_tiger |
| forest  | grass within 3 of a tall grove prop | hedgehog, tree_stump, forest_poring(+_2) |
| dirt    | lightdark_dirt (roads, forest floor) | dark_donkey |
| snow    | regular_snow | white_rabbit, snow_demon, mammoth |
| ice     | crystal_ice | ice_crystal_golem, ice_poring |
| dark    | black_mountain rock | malformed_creature, lava_salamander(+_2), lava_poring |
| stone   | stone_mountain | stone_turtle (also the bridge guard), stone_golem |
| sand    | beaches | (heuristic home for future `*sand*` ids) |
| water   | water within 4 cells of land | mystical_frog, water_poring |
| cave    | THE CAVE floor, `elev [0,1]` | masked_shadow_creature, night_beast, diablo, diablo_2 |

Per habitat: 4-connected components ≥ ~30 cells (forest 12), biggest kept;
every member gets a zone, extra components cycle back over members, and members
sharing one component get OVERLAPPING zones with the population split so the
density stays constant (the four cave dwellers share the dungeon floor this
way). Diagonal contacts are healed so every traced boundary is provably simple.
Validation asserts each zone has at least `num` valid standable cells at its
claimed elevation before the file is written.

Two placement laws (maintainer 2026-07-29):

- **`the_island2` MUST contain every monster** — it is the map closest to the
  end game (`MUST_HAVE_ALL` in spawns.py). Generation guarantees a zone for
  every roster id: a monster its habitat rules missed falls back to the biggest
  component of its own habitat (no size threshold) and then to a neighbouring
  habitat, and the build ASSERTS full coverage — so a future terrain change
  that erases a habitat fails the build ("`the_island2` is missing monster(s)")
  instead of silently dropping the creature.
- **feature-test maps carry NO monsters** — `prop_demo`, `trans_demo`,
  `glow_test`, `occlusion_test` each exercise ONE rendering feature, so they
  ship an explicit empty `zones: []` (`NO_SPAWN_WORLDS`).

`monster_demo` is the third special case: its builder (`monsterdemo.py`) writes
explicit pad zones (`BUILDER_OWNS`).

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

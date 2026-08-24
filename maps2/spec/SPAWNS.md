# Monster spawn zones — `pixel-maps2/spawns@1`

maps2 owns the REAL monster spawn areas (maintainer decision). Every world
ships `maps2/worlds/<name>/spawns.json` next to its `world.json`:

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

- Vertices are **tile-corner coordinates** (integers; cell `(x,y)` spans
  corners `(x,y)`–`(x+1,y+1)`), listed once — the polygon closes implicitly.
- Any shape is legal, **concave or convex**, but it must be a *real* area:
  **no self-intersections** (generator-asserted). The generator traces
  cell-region boundaries, so edges are axis-aligned; the format itself would
  allow any simple polygon.
- A zone's cells are the cells whose **CENTER lies inside** the polygon
  (even-odd rule).
- The area is where the monster **MAY** be. The game must validate every actual
  spawn/roam point (standable surface within `elev`, no prop) — so a polygon
  may freely span the odd boulder or wall cell.
- **NEVER water** — the water law below. The one thing a polygon may not
  contain, guaranteed by the geometry rather than left to the game.
- Zones **may overlap**: different monsters share ground, and two zones can
  cover the SAME cells at different elevations (see `elev`). Overlap is bounded
  by the crowding law — sharing ground is fine, piling up on it is not.

## The water law

**No zone polygon on any world contains a single water-surfaced cell**
(maintainer: "monsters can't swim… we're gonna soon make water into a safe
zone"). Not "the game filters them out" — the polygons themselves are dry, so
the guarantee holds however the game evolves. Concretely: the game's
`buildZoneRuntimes` flips an ENTIRE zone to swimming when its swim cells
outnumber its standable ones — which is what used to put frogs in the ocean;
with zero water inside any polygon that branch can never fire, and a water safe
zone cannot be violated from the map side.

A cell is **water-surfaced** for a zone banded `[lo,hi]` when its base material
is water **and** no deck inside that band covers it. So a bridge guard is legal
(it stands ON the span, `elev [24,24]`) while the identical polygon at
`elev [0,0]` — the water under the span — fails the assert.

Enforcement is two-sided, in `spawns.py`:

- `dry_mask()` builds every generated zone dry: a diagonal fill that would land
  on water is refused, and a pond the outer ring would enclose is **cut open**
  (spawns@1 rings have no holes — the cheapest straight corridor from the pond
  to outside the ring is removed and the boundary snakes around it).
- `validate_zone()` re-asserts it for **every zone of every world**, including
  hand-written and builder-owned files — the law also covers zones `dry_mask`
  never touched.

No habitat puts a monster on water: the former `water` habitat is `shore`, the
**land** band within 4 cells of water.

## `elev` — which surface is meant (caves & bridges)

`[min, max]`, inclusive, in world levels. A monster of this zone may stand at a
cell on whichever surface — **base OR deck** — has its walk level inside the
range. This single field disambiguates every layered case:

- **the cave** under the_island2's east mountain: floor zone `elev [0,1]`
  (base), while the snowfield zones above it ride the `kind:"cave"` roof decks
  at `[24,40]` — same cells, different zones, no ambiguity;
- **bridges**: a zone on the span uses the deck level (`[24,24]` for the high
  gorge bridge); the water below belongs to nobody — the water law;
- sloping ground (a grass trail climbing benches) simply widens the range.

## `num` — population

How many of this monster live in the zone; the game may treat it as the
concurrent cap per zone.

Population is budgeted **per monster TYPE, not per zone** (maintainer: the
roster should be "balanced… not the same, just similar" — pure per-area density
gave 24 butterfly dragons and 1 hedgehog):

1. world budget `B = land cells / WORLD_CELLS_PER_MONSTER (180)`, clamped so
   every type present gets at least `MON_TOTAL_MIN (1)` and none more than
   `MON_TOTAL_MAX (9)`;
2. `B` is split **evenly** across the types living on the world by largest
   remainder; the few +1s go to the types with the most habitat — the only nod
   left to raw area;
3. each type's own total is spread across **its** zones in proportion to zone
   area (min 1 per zone, capped by the zone's spawnable cells **and by its
   room** — the crowding law).

Density still decides *where* a type is thickest, never *how many* exist.

`WORLD_CELLS_PER_MONSTER` is the ONE dial for how busy a world feels — one
constant applied to every map, so a change lands proportional to land area
instead of being trimmed off whichever map someone was looking at. 137 → 205
("reduce the total number of monsters on the map by 25%"), then 205 → **180**
when the roster grew 24 → 57 ("I can agree on increasing the total amount of
monsters on the map by 25%… you will probably have to spawn less of the
monsters already on the map so everyone can be included"): `the_island2`
99 → 123, and the per-species share falls 4-7 → 2-3, which is the trade he
asked for.

**The floor is "present at all", and that is why it is 1.** It was 3, and
`n × 3` is a floor that GROWS with the species count — backwards, since the
more species share a fixed island the fewer each can have. The roster going
24 → 57 made that floor demand **171** monsters of a world whose land asks for
124, and it would climb again with every creature the monsters agent adds. At 1
the floor states the only thing always true — a species that lives on a world
has at least one individual there, or it is not on the world at all, which is
exactly what `MUST_HAVE_ALL` promises — and leaves the land as the only dial.

## The crowding law

**NOTHING PILES UP** (maintainer: "LOL! Why have you placed this many monsters
at the same place 😂"). The trap: each species independently picks the nearest
component it is *allowed*, so several sharing a habitat all converge on the
same patch — four forest species once put 24 monsters on one 46-cell copse
with the plains zones over the top, no rule broken.

Room is a first-class quantity. For a surface `(x, y, level)`:

```
density = SUM over zones covering it of  num / |zone spawn cells|
```

— the expected monsters standing on it. Not a proxy: the server draws roam
targets **uniformly** from exactly those cells (`pickMonsterTarget`,
`WorldRoom.ts`), so this is what the player sees. It may never exceed
**`MAX_DENSITY = 0.05`** — one monster per 20 cells, at most ~4 in a 9×9.

The **level is part of the key**: the cave floor at elev 0-1 lies directly
under the black-mountain rock at 32-36. Different *floors of the same
building* — a player on the summit never meets what lives under their boots —
so the law does not add them together.

**ENCLOSED GROUND CARRIES LESS** (maintainer: "reduce the number of monsters in
the cave by 50%"). A dungeon is corridors and rooms with nowhere to back off
to, so the same count that reads sparse on a meadow reads as a swarm
underground. Enclosed surfaces get `CAVE_DENSITY_F (0.4)` of the open cap —
0.02/cell, one per 50 cells (took the_island2's cave 18 → 9 monsters, costing
the rest of the island nothing). Enclosure is a property of the SURFACE, never
the column: the ledge on top of the cave shares every (x,y) but is under open
sky — `enclosed()` asks whether your feet are below the slab's underside.

Three generator mechanisms, then one gate:

1. **Room picks the component.** Each component carries `cells × MAX_DENSITY`
   monsters. A species prefers one with room for its whole population; among
   those it takes the **nearest** (the difficulty gradient is untouched —
   species spread *sideways*, never inwards). When nothing has room the
   **emptiest** wins — falling back to "nearest" is what once put all four
   black-mountain species on one ledge ("nearest" is the same answer for all).
   Spare components go to the species with the **least room so far**, not the
   first name in the roster.
2. **Room caps the population.** A zone never holds more than
   `cells × MAX_DENSITY`; spill goes to that species' other zones — a full
   copse sends hedgehogs to the next copse instead of stacking them.
3. **The overlap is settled.** Where the sum still goes over, the thickest
   contributor gives a monster back until it doesn't; then every species under
   its allocation gets monsters back wherever its own ground has headroom
   (`enforce_density` + `topup_population`). Both monotone, so they terminate.

`assert_density()` fails the build if any surface is still over — including a
hand-written `spawns.json`, which the mechanisms never touch. It binds above
the irreducible **one monster per zone** (a lone turtle on a 14-cell footbridge
at 0.071/cell is not a pile-up); ground where several species squeezed to one
each is still over is **reported**, like the gradient's nowhere-far-enough.

`monster_demo` is the one exemption (`CROWDING_EXEMPT`): a display case, one
5×5 pad per monster with two each — 0.08/cell is the point of the map.

Measured on the_island2 when the law landed: peak **0.527 → 0.049**
monsters/cell, the copse **24.4 → 2.0** in a 9×9, every species still present.

## Generation (rules, never spot edits)

`maps2/pipeline/spawns.py` derives every world's zones from its `world.json` by
habitat rules — deterministic, idempotent (`python maps2/pipeline/spawns.py`).
`monsters/config/roster.json` is the monster-id authority and grows on its own
(the PixelLab MONSTER tag decides membership — 57 monsters today): every id
maps to ONE habitat key via `MONSTER_HABITAT` in spawns.py; `NAME_HINTS`
guesses a home for brand-new ids until the table is extended (note: a new
`*_water`/`*_frog` id lands on the BANK — there is no water habitat). Habitat
keys, with the explicitly-tabled residents:

| habitat | ground | the cast it holds (57 species) |
|---------|--------|-------------------|
| grass   | open saturated_grass | **14** — the plains: horses, armoured grazers, plains hunters |
| forest  | grass within 6 of a tall grove prop | **6** — copse dwellers, the root bear, the porings |
| dirt    | lightdark_dirt (roads) | **4** — road-haunters: a waiting farm dog, two horses, a night gallop |
| sand    | beaches | **2** — the sun cat and the sand-swimmer |
| shore   | **land** within 4 cells of water — the bank | **5** — the bog cast: two fen cats, the swamp bear, the frogs |
| stone   | stone_mountain | **6** — grey bulks: brutes, golems, the granite bear, the maw |
| snow    | regular_snow | **6** — the cold cast: wolves, bears, the storm stag, the mammoth |
| ice     | crystal_ice | **3** — the ice constructs |
| dark    | black_mountain rock | **7** — the volcanic cast: the magma pack, the obsidian lion, the salamanders |
| cave    | THE CAVE floor, `elev [0,1]` | **4** — the dungeon, at its cap |

The per-monster table is `MONSTER_HABITAT` in `spawns.py`, grouped by habitat and
ordered by level, every line carrying the one-line reason that creature lives
there. **A habitat holds far fewer species than its cell count suggests**, because
the crowding law bites per COMPONENT, not per habitat: `dirt` is 872 cells but a
thin road ribbon, `dark` is 459 cells in five small ledges, `forest` is scattered
copses. Measured on the_island2, over-subscribing them costs monsters — nine
species in forest and six on dirt shaved six species to a single individual each.
Sizing a habitat's cast by its component structure rather than its area is what
keeps every species really present.

`TREE_R = 6` is the woods a grove casts, not the shade of one trunk (at 3,
every tall prop was its own 7×7 island of "forest" and the forest species had
nowhere to spread to but each other's laps).

Per habitat: 4-connected components ≥ ~30 cells (forest 20 — a zone needs
`1/MAX_DENSITY` cells to hold one monster legally), biggest kept, up to two per
member so the crowding law has somewhere to spread to. Every member gets a
zone; spare components go to whichever member has the least room; members that
still share one component get OVERLAPPING zones with the population split so
density stays constant (the four cave dwellers share the dungeon floor this
way). Diagonal contacts are healed so every traced boundary is provably simple.
Validation asserts each zone has ≥ `num` valid standable cells at its claimed
elevation before the file is written.

Zones are re-derived automatically whenever a world is written (`save_world()`
calls `spawns.refresh()`), so `build.py <world>` and running a builder directly
both re-check zones against the new terrain — a terrain edit cannot leave a
stale zone on new water; the build fails instead.

## The difficulty gradient

**Distance from the arrival point is a function of difficulty** (maintainer:
"Why do you spawn Duskfang next to newcomers?… Try to make them enjoy the game
instead"). The trap: habitat alone knows nothing about danger — a level-8
grass-dwelling hunter had a zone touching the spawn while the level-1 frog sat
54 cells away.

Distance is measured in **WALK cells** — what the player travels, not straight
line (the_island2 is 168 cells across in straight line and 467 on foot):

    keep_out(monster) = SAFE_R + (level - 1) * LVL_STEP + AGGRO_PUSH if it hunts
                      = 6      + (level - 1) * 5        + 14

The ranking is **not invented here**: `level` and `aggro_radius_wu` come from
the game's own combat tuning (`live/tuning/monsters.json`, the same file
`games2/server/src/tuning.ts` fights with) — a rebalance there moves the
monsters on the map instead of silently disagreeing with it.

`LVL_STEP` is calibrated against the terrain, not picked: THE CAVE is a single
component 112 walk-cells out holding all four cave dwellers, the worst
Balefiend (L18, aggressive): 6 + 17·5 + 14 = 105 ≤ 112, so every monster on
the_island2 satisfies its own floor with none falling back.

Two mechanisms, the second the one that matters:

- each monster takes the **nearest** habitat it is allowed — easy monsters come
  as close as terrain permits;
- the too-close cells are handed to `dry_mask()` as **forbidden ground**, the
  same machinery as the water law. Picking a far-enough *component* is not
  enough: a habitat is often one sprawl covering half the map and the polygon
  fill can bulge back toward the spawn. Forbidding by cell means the polygon
  **cannot contain** a cell inside the floor, so the game cannot roam a monster
  back toward the newcomers.

`assert_gradient()` enforces before the file is written: **nothing at all**
within `SAFE_R` walk-cells of the arrival point (absolute — a fresh player has
40 HP and the map may not spend any of it), and every monster at or beyond its
`keep_out` *unless* its habitat genuinely offers nowhere further, which is
**reported**, never hidden.

The floor is a **minimum**, not an exact ordering: terrain may push a monster
further than its level requires (snow only exists on the mountain), never pull
one closer. On the_island2 the first things a newcomer meets are a level-1 frog
and a level-2 poring, both passive, 14 cells out; the nearest thing that HUNTS
is 55 cells away.

## The placement laws

- **difficulty scales with distance from the arrival point** — the gradient.
- **no monster spawns on water** — the water law.
- **`the_island2` MUST contain every roster monster** (`MUST_HAVE_ALL` — the
  map closest to the end game). Generation guarantees a zone for every roster
  id: a monster its habitat rules missed falls back to the biggest component of
  its own habitat (no size threshold), then to a neighbouring habitat
  (`FALLBACK_HABS`), and the build ASSERTS full coverage — a terrain change
  that erases a habitat fails the build instead of silently dropping the
  creature.
- **feature-test maps carry NO monsters** — `prop_demo`, `trans_demo`,
  `glow_test`, `occlusion_test`, `house_demo` each exercise one feature and
  ship an explicit empty `zones: []` (`NO_SPAWN_WORLDS` — intent explicit, not
  a missing file).
- `monster_demo` writes its own explicit pad zones (`BUILDER_OWNS`).

## The demo world — `monster_demo`

One **5×5 pad per monster**, floored with the tile that creature most likely
lives on (no pad is water — the water law; the amphibious-looking ones get a
beach), on a neutral stone courtyard so every spawn area is visible at a
glance. Each pad is one zone (`num 2`, `elev [0,0]`), big enough to watch the
monster wander. Rebuild: `python maps2/pipeline/build.py monster_demo`.

## Consumers

**Live.** The game loads `spawns.json` per world (`games2/shared/src/monsters.ts`
parses it; worlds without one, or with `zones: []`, spawn nothing) — the old
fake near-spawn debug rectangles are gone. Point-in-polygon + the `elev`
surface rule above; the server roams monsters uniformly over the zone's spawn
cells (`WorldRoom.ts`), staying inside the polygon at the zone's surface.

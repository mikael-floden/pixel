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
  spawn/roam point (standable surface within `elev`, no prop) — so a polygon may
  freely span the odd boulder or wall cell.
- **NEVER water** — see the water law below. This is the one thing a polygon may
  not contain, and it is guaranteed by the geometry rather than left to the game.
- Zones **may overlap** each other: different monsters share ground, and two
  zones can even cover the SAME cells at different elevations (see `elev`).
  Overlap is bounded by the crowding law below — sharing ground is fine, piling
  up on it is not.

## The water law

> "You need to fix so no monster can spawn on water. Monsters can't swim. We're
> gonna soon make water into a safe zone." — maintainer, 2026-08-05

**No zone polygon on any world contains a single water-surfaced cell.** Not "the
game filters them out" — the polygons themselves are dry, so the guarantee holds
however the game evolves. That matters concretely: the game's `buildZoneRuntimes`
flips an ENTIRE zone to swimming when its swim cells outnumber its standable
ones, which is exactly what used to put frogs in the ocean. With zero water
inside any polygon that branch can never fire, and a water safe zone cannot be
violated from the map side.

A cell is **water-surfaced** for a zone banded `[lo,hi]` when its base material
is water **and** no deck inside that band covers it. So the bridge guard is legal
(it stands ON the span, `elev [24,24]`) while the water *under* the same span is
not — the identical polygon at `elev [0,0]` fails the assert.

Enforcement is two-sided, in `spawns.py`:

- `dry_mask()` builds every generated zone dry. A diagonal fill that would land
  on water is refused; a pond the outer ring would enclose is **cut open** —
  spawns@1 rings have no holes, so the cheapest straight corridor from the pond
  to outside the ring is removed and the boundary snakes around it instead.
- `validate_zone()` re-asserts it for **every zone of every world**, including
  hand-written and builder-owned files, so the law also covers zones `dry_mask`
  never touched.

There is no habitat that puts a monster on water; the former `water` habitat is
now `shore`, the **land** band within 4 cells of water.

## `elev` — which surface is meant (caves & bridges)

`[min, max]`, inclusive, in world levels. A monster of this zone may stand at a
cell on whichever surface — **base OR deck** — has its walk level inside the
range. This single field disambiguates every layered case:

- **the cave** under the_island2's east mountain: floor zone `elev [0,1]`
  (base), while the snowfield zones above it ride the `kind:"cave"` roof decks
  at `[24,40]` — same cells, different zones, no ambiguity;
- **bridges**: a zone on the span uses the deck level (`[24,24]` for the high
  gorge bridge); the water below belongs to nobody — see the water law;
- sloping ground (a grass trail climbing benches) simply widens the range.

## `num` — population

How many of this monster live in the zone; the game may treat it as the
concurrent cap per zone.

Population is budgeted **per monster TYPE, not per zone** (maintainer
2026-07-29: the roster should be "balanced… not the same, just similar" — pure
per-area density gave 24 butterfly dragons and 1 hedgehog):

1. the world's budget `B = land cells / 205`, clamped so no type is rarer than
   3 or commoner than 9 (`the_island2`: 21978 land cells → **B = 107**);
2. `B` is split **evenly** across the types that live on the world by largest
   remainder — with 24 types and B=107, eleven get 5 and thirteen get 4. The few
   +1s go to the types with the most habitat, the only nod left to raw area;
3. each type's own total is then spread across **its** zones in proportion to
   zone area (min 1 per zone, capped by the zone's spawnable cells **and by its
   room** — see the crowding law).

So density still decides *where* a type is thickest — `butterfly_dragon` puts 3
of its 5 on the big meadow and 2 on the smaller one — never *how many* exist.

`WORLD_CELLS_PER_MONSTER` is the one dial for how busy the world feels: it went
137 → **205** on 2026-08-07 ("reduce the total number of monsters on the map by
25%. I think we have too many now"), which is one constant applied to every
world, so the cut lands proportionally to land area everywhere rather than being
trimmed off whichever map someone was looking at. `the_island2`: 141 → **106**.
Small worlds do not shrink — `demo_isle` and `demo_lost` were already sitting on
the `MON_TOTAL_MIN = 3` floor, which is exactly what that floor is for.

## The crowding law

> "LOL! Why have you placed this many monsters at the same place 😂 Looks
> funny!" — maintainer, 2026-08-07

He was pointing at the copse east of the plains. Four forest species —
`hedgehog`, `tree_stump` and both forest porings — had all picked the **same
46-cell component**, six of each, with the two plains zones lying over the top:
**24 monsters under one tree**, one every two tiles.

No rule was broken, and that was the problem. A zone said *where* a monster may
live and never *how much room it needs*, and each species picks the nearest
component it is allowed to live in **independently of the others** — so when
several share a habitat they all converge on the same patch. Habitat and the
difficulty gradient both pointed the same way; nothing pointed apart.

Room is now a first-class quantity. For a surface `(x, y, level)`,

```
density = SUM over zones covering it of  num / |zone spawn cells|
```

is the expected number of monsters standing on it — the server draws roam
targets **uniformly** from exactly those cells (`pickMonsterTarget`,
`WorldRoom.ts`), so this is what the player sees, not a proxy for it. It may
never exceed **`MAX_DENSITY = 0.05`** — one monster per 20 cells, at most ~4 in
a 9×9 patch of ground.

The **level is part of the key**: the cave floor at elev 0-1 lies directly under
the black-mountain rock at 32-36, with the benches and the snow cap stacked over
both. Those are different *floors of the same building* — a player on the summit
never meets what lives in the cave under their boots — so the law does not add
them together.

Three mechanisms in the generator, then one gate:

1. **Room picks the component.** Each component carries `cells × MAX_DENSITY`
   monsters. A species prefers one with room for its whole population; among
   those it still takes the **nearest**, so the difficulty gradient is
   untouched — species spread *sideways* across the habitat, never inwards.
   When nothing has room the **emptiest** wins (falling back to "nearest" here
   is what put all four black-mountain species on one ledge — "nearest" is the
   same answer for all of them). Spare components go to the species with the
   **least room so far**, not to the first name in the roster.
2. **Room caps the population.** A zone never holds more than `cells ×
   MAX_DENSITY`; the spill goes to that species' other zones, so a full copse
   sends hedgehogs to the next copse instead of stacking them six deep.
3. **The overlap is settled.** Where the sum still goes over, the thickest
   contributor gives a monster back until it doesn't; then every species left
   under its allocation gets monsters back wherever its own ground still has
   headroom (`enforce_density` + `topup_population`). Both are monotone, so
   they terminate.

`assert_density()` then fails the build if any surface is still over — including
for a hand-written `spawns.json`, which none of the three mechanisms touch. It
binds on everything above the irreducible **one monster per zone**: a lone
turtle on a 14-cell footbridge sits at 0.071/cell and no arithmetic makes that a
pile-up. Ground where *several* species are squeezed to one monster each and it
is still over is **reported**, the same way the gradient reports a habitat with
nowhere far enough.

`monster_demo` is the one exemption (`CROWDING_EXEMPT`): it is a display case,
one 5×5 pad per monster with two of each, and 0.08/cell is the point of the map.

On `the_island2`: peak **0.527 → 0.049** monsters/cell, the copse **24.4 → 2.0**
monsters in a 9×9, at the cost of 19 of 160 monsters and with every one of the
24 species still present.

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
| forest  | grass within 6 of a tall grove prop | hedgehog, tree_stump, forest_poring(+_2) |
| dirt    | lightdark_dirt (roads, forest floor) | dark_donkey |
| snow    | regular_snow | white_rabbit, snow_demon, mammoth |
| ice     | crystal_ice | ice_crystal_golem, ice_poring |
| dark    | black_mountain rock | malformed_creature, lava_salamander(+_2), lava_poring |
| stone   | stone_mountain | stone_turtle (also the bridge guard), stone_golem |
| sand    | beaches | (heuristic home for future `*sand*` ids) |
| shore   | **land** within 4 cells of water — the bank | mystical_frog, water_poring |
| cave    | THE CAVE floor, `elev [0,1]` | masked_shadow_creature, night_beast, diablo, diablo_2 |

`TREE_R = 6` is the woods a grove casts, not the shade of one trunk: at 3 every
one of the island's 8 tall props was its own 7×7 island of "forest" and the four
forest species had nowhere to spread to but each other's laps.

Per habitat: 4-connected components ≥ ~30 cells (forest 20 — a zone needs
`1/MAX_DENSITY` cells to hold one monster legally), biggest kept, up to two per
member so the crowding law has somewhere to spread to. Every member gets a zone
and spare components go to whichever member has the least room; members that
still end up sharing one component get OVERLAPPING zones with the population
split so the density stays constant (the four cave dwellers share the dungeon
floor this way). Diagonal contacts are healed so every traced boundary is
provably simple. Validation asserts each zone has at least `num` valid standable
cells at its claimed elevation before the file is written.

Zones are re-derived automatically whenever a world is written: `save_world()`
calls `spawns.refresh()` for the world it just saved, so `build.py <world>` and
running a builder directly both re-check the zones against the new terrain. A
terrain edit therefore cannot leave a stale zone sitting on new water — the
build fails instead.

## The difficulty gradient

> "Why do you spawn Duskfang next to newcomers? They are aggressive and will
> kill them immediately. What's wrong with Mirewart? Why not scale up the
> difficulty as you progress? Quillkin should also be closer. You just want
> Newbies to have a hard time. Try to make them enjoy the game instead."
> — maintainer, 2026-08-06

Habitat alone decided placement before this, and habitat knows nothing about
danger. Duskfang is a sabre-toothed tiger, tigers live on grass, the arrival
point is grass — so a level-8 hunter that kills a fresh 40 HP player in three
hits had a zone **touching the spawn**, while Mirewart (level 1) sat 54 cells
away and Quillkin (level 4) was the most distant monster on the map at 152. The
correlation between level and distance was nil.

**Distance from the arrival point is now a function of difficulty**, measured in
WALK cells — what the player actually travels — not straight line, which on a
map with a mountain, a gorge and an ocean are very different numbers (the
island is 168 cells across in straight line and 467 on foot).

    keep_out(monster) = SAFE_R + (level - 1) * LVL_STEP + AGGRO_PUSH if it hunts
                      = 6      + (level - 1) * 5        + 14

The ranking is **not invented here**: `level` and `aggro_radius_wu` come from the
game's own combat tuning (`live/tuning/monsters.json`, the same file
`games2/server/src/tuning.ts` fights with), so a rebalance there moves the
monsters on the map instead of silently disagreeing with it.

`LVL_STEP` is calibrated against the terrain rather than picked: THE CAVE is a
single component 112 walk-cells out holding all four cave dwellers, the worst of
them Balefiend (L18, aggressive). 6 + 17·5 + 14 = 105 ≤ 112, so every monster on
the_island2 satisfies its own floor with none falling back.

Two mechanisms enforce it, and the second is the one that matters:

- each monster takes the **nearest** habitat it is allowed — so easy monsters
  come as close as the terrain permits rather than ending up wherever;
- the too-close cells are handed to `dry_mask()` as **forbidden ground**, the
  same machinery as the water law. Picking a far-enough *component* is not
  enough on its own: a habitat is often one sprawl covering half the map, and
  the polygon fill can bulge back toward the spawn. Forbidding by cell means the
  polygon **cannot contain** a cell inside the floor, so the game cannot roam a
  monster back toward the newcomers.

`assert_gradient()` then enforces two rules before the file is written: **nothing
at all** within `SAFE_R` walk-cells of the arrival point (absolute — a fresh
player has 40 HP and the map may not spend any of it before they have looked
around), and every monster at or beyond its `keep_out`, *unless* its habitat
genuinely offers nowhere further, which is **reported** rather than hidden.

Result on the_island2 — the first things a newcomer meets are a level-1 frog and
a level-2 poring, both passive, 14 cells out; the nearest thing that **hunts** is
55 cells away:

| walk | monster | lvl | hunts | was |
|---|---|---|---|---|
| 14 | Mirewart | 1 | – | 54 |
| 14 | Puddling | 2 | – | 14 |
| 29 | Quillkin | 4 | – | **152** |
| 55 | Duskfang | 8 | **yes** | **0** |
| 56 | Nightmule | 11 | – | **5** |
| 112 | Balefiend | 18 | yes | 79 |
| 150 | Rimeshard | 19 | – | 100 |

The floor is a **minimum**, not an exact ordering: Fluffang (L5) sits at 121
because snow only exists on the mountain. Terrain may push a monster further
than its level requires; it may never pull one closer.

Four placement laws (maintainer 2026-07-29, 2026-08-05, 2026-08-06):

- **difficulty scales with distance from the arrival point** — the gradient above.
- **no monster spawns on water** — the water law above.

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
the tile that creature most likely lives on (no pad is water — the water law;
the amphibious-looking ones get a beach), on a
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

# `pixel-maps2/npcs@1` — NPC placement

**Owner:** maps2 (the Map2 agent). **Added:** 2026-08-05, at the maintainer's
request: *"Can you please reference and place some NPCs in the world. You can use
the type AMBIENT or MERCHANT. When/if placing a MERCHANT — please use an NPC that
actually looks like a MERCHANT (has something to sell). Think about where you
place them so it makes sense (makes a good game)."*

maps2 owns **where people stand**, exactly as it owns where monsters spawn.
characters2 owns **who they are**. This format is the join between them and
restates nothing: the art, the display name, the role and the lore all stay in
`characters2/npcs/index.json`, keyed by the folder id this file references.

Every world ships `worlds/<name>/npcs.json` beside `world.json` and
`spawns.json`:

```json
{
  "schema": "pixel-maps2/npcs@1",
  "world": "the_island2",
  "npcs": [
    {
      "id": "house-1",
      "character": "51be6251",
      "name": "Nyssa",
      "type": "MERCHANT",
      "x": 200, "y": 118,
      "elev": 0,
      "facing": "south",
      "anchor": "house",
      "wares": ["MISC", "CONSUMABLE"]
    }
  ]
}
```

| field | meaning |
|---|---|
| `id` | unique within the world; `<anchor>-<n>` |
| `character` | folder under `characters2/npcs/` — **the** reference |
| `name` | characters2' `display_name`, denormalised for readability. Asserted equal at build, so an upstream rename FAILS instead of rotting |
| `type` | `AMBIENT` or `MERCHANT` — the maintainer's two |
| `x`, `y` | tile cell |
| `elev` | the ground level they stand on. Same role as `spawns@1.elev`: it says WHICH surface, so a cave-floor NPC at `[0]` is unambiguous under a roof deck at 24 |
| `facing` | one of characters2' 8 rotations |
| `anchor` | which placement rule produced them — provenance, not behaviour |
| `wares` | MERCHANT only: `items/` TYPE tags, validated against `items/viewer_data.json` |

## The two types

**AMBIENT** — someone the world is more alive for. No shop. Cast by role
affinity for the place: elders greet the newly fallen at the arrival point,
mercenaries and veterans loiter at the cave mouth, scouts watch the bridges,
wanderers walk the roads. Cast is picked from characters2 **by role**, so new
NPC art joins the pool with no edit here.

**MERCHANT** — has something to sell, and **must look like it**. `MERCHANT_LOOK`
in `npcs.py` is the one hand-curated table in the whole placement system, and it
is hand-curated on purpose: *"looks like a merchant"* is a judgement about ART
that no terrain rule can make. Only characters whose sprite visibly presents
wares are eligible.

The `trader` ROLE is deliberately **not** sufficient. characters2 has two
`trader`s; one (Joss) holds up four filled vials and is in, the other (Halvard)
is a fur-collared traveller with a waterskin and nothing to sell, and is out.
A character like that standing in a shop reads as a lost villager.

Current cast, and what each sprite actually shows:

| character | role | the art shows | sells |
|---|---|---|---|
| Nyssa | quartermaster | a vendor's tray of goods on a neck strap | MISC, CONSUMABLE |
| Thorne | armorer | a gilded breastplate held out for inspection | ARMOR |
| Sigrun | weaponsmith | a sword presented flat across both hands | SWORD, BOW |
| Norvel | wandmonger | a bristling quiver of wands, more at the belt | WAND |
| Aric | alchemist | a red and a blue potion held up, one per hand | CONSUMABLE, MISC |
| Maddox | enchanter | a glowing stone in one hand, a scroll in the other | SOUL, MISC |
| Joss | trader | four filled vials displayed at arm's length | CONSUMABLE, MISC |

Between them they cover all seven `items/` TYPE tags.

## Anchors — where placement makes sense

Landmarks are **derived from world.json**; no world knows it is being decorated,
and a new world gets a cast for free.

| anchor | derived as | who goes there |
|---|---|---|
| `arrival` | the player spawn | elders/scholars — you have just fallen, and somebody should be there |
| `house` | a `kind:"roof"` deck; the focus is its **doorway** | the market: the general store, the armourer, the weaponsmith, plus residents |
| `cave` | cave-floor cells that meet open ground at a walkable step — the mouth — anchored **outside** | the alchemist (the last shop before you go down) and the mercenaries who came back up |
| `bridge` | the biggest `kind:"bridge"` deck, anchored at its **end** | a merchant at a chokepoint everybody crosses, and a scout |
| `road` | junction cells (degree ≥ 3) of the dirt-road graph, spread ≥ 40 cells apart | the soulstone dealer — the stone trade IS the economy (`lore/RED_LINE.md` §6) — and roadside travellers |
| `shore` | beach cells touching water | people looking out to sea |

## The laws

Asserted for every NPC of every world before the file is written, so a terrain
change breaks the **build** rather than stranding somebody in the deployed game.

1. **Dry, standable ground.** Never water — the water law applies to people too
   — never void, never a prop cell, never sealed under a slab.
2. **Reachable on foot from the player spawn**, walked with the game's own rule
   (4-neighbour, climb ≤ `WALK_CLIMB` = 1, drops free, `baseUnderDeckOpen` for
   ground under a deck). *A shop you cannot walk to is not a shop.*
3. **Never in a chokepoint.** Detected by counting runs of open ground around
   the 8 neighbours: two or more runs means the space on either side of you
   only connects *through* you.
4. **Never in a doorway — stand NEXT to an opening, never in front of it.**
   (Maintainer, 2026-08-05: *"Did you have to block both the entrance to the
   house and to the cave with your NPCs? Why can't they stand next to instead
   of in front the door/entrance?"*) A **portal** is a door, a cave mouth or a
   bridge head, and "in the opening" has **two** meanings that must both be
   kept clear:
   - the **grid lane** — the cells straight out along the passage; and
   - the **screen strip** — cells within `DOOR_COLS` of the opening's `(x−y)`
     and in front of it. This is the one that actually bit: the house door at
     `(201,117)` and a shopkeeper at `(202,118)` have the *identical* screen
     column `(201−117) = (202−118) = 84`, so he stood squarely in the opening
     while the grid lane `x=201` was perfectly clear.

   Clearance is measured from the **opening itself** — the gap in the wall, the
   cave-floor cell at the mouth — not from the step outside it. Measuring from
   the step is off by one column and lets a sprite clip the edge of the door.
5. **Never in the spawn campfire.** The game draws one animated campfire at
   every world's arrival point — the only `objects/` asset it draws, and canon
   (`lore/RED_LINE.md` §2: *"there is a campfire burning at the place where you
   arrive"*). It is **not** a prop in `world.json`, so nothing in the terrain
   says it is there, and the first cast duly stood a commoner in the flames —
   spotted in-game by the maintainer with *"Living on the edge :)"*.
   `WorldScene.ts placeCampfire()` takes the first standable same-level
   neighbour of the spawn from a fixed offset order; `fire_cells()` deliberately
   does **not** trust its own standability test to agree with theirs, and keeps
   every candidate up to *and including* the first it believes is standable,
   plus a one-cell ring — so a small disagreement still lands on a clear cell.
6. **Never hidden from the camera.** Derived from the painter order `(x+y, y)`
   rather than guessed — which catches the non-obvious case of equal `x+y` with
   greater `y`, i.e. one step round the side of a building. An NPC nobody can
   see is worse than no NPC.
7. **Never overlapping another sprite**, measured in **screen** space, not grid
   space: iso puts `(x+2, y+2)` directly below `(x, y)` with 60px between them,
   so plain grid distance happily stacks two sprites into one blob. Side by
   side needs 3 columns (96px) — 2 leaves them shoulder-to-shoulder.
8. **Not on or crowding the arrival point** — you land in open ground.
9. **References resolve**: the character exists in characters2, its art is on
   disk, `name` still matches upstream, and every ware is a real `items/` TYPE.
10. **Indoors is off limits** — the house belongs to whoever lives there; the
   market forms outside the door. (The cave is explicitly *not* indoors.)

`prop_demo`, `trans_demo`, `glow_test`, `occlusion_test` and `monster_demo` ship
an explicit empty `npcs: []` — they each exercise one feature and people would
only get in the way.

## Rebuilding

```
python maps2/pipeline/npcs.py                # every world
python maps2/pipeline/npcs.py the_island2    # only the named ones
python maps2/pipeline/npcs.py --check        # validate what is on disk, exit 1 on any violation
```

You rarely need to: `worldio.save_world()` re-derives the sidecars for the world
it just wrote, so `build.py <world>` and running a builder directly both
re-place the cast against the new terrain automatically.

## Consumers

Nothing reads this yet — the game has no NPC entity (games2 issue #16, the
dialogue box, is waiting on exactly this). That is the same order `spawns@1`
landed in: maps2 shipped the data, the game wired it up after. The art is
already in the deploy image (`.dockerignore` allows all of `characters2`), but
`games2/scripts/build-manifest.mjs` currently only emits the two PLAYER
characters from `characters2/humans/`, so the game will need `characters2/npcs/`
in its manifest before it can draw anyone.

# `pixel-maps2/npcs@1` — NPC placement

**Owner:** maps2 (the Map2 agent). maps2 owns **where people stand**, exactly
as it owns where monsters spawn; characters2 owns **who they are**. This format
is the join between them and restates nothing: art, display name, role and lore
all stay in `characters2/npcs/index.json`, keyed by the folder id this file
references.

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
| `elev` | the ground level they stand on. Same role as `spawns@1.elev`: it says WHICH surface, so a cave-floor NPC at `0` is unambiguous under a roof deck at 24 |
| `facing` | one of characters2' 8 rotations |
| `anchor` | which placement rule produced them — provenance, not behaviour |
| `wares` | MERCHANT only: `items/` TYPE tags, validated against `items/viewer_data.json` |

## The two types

**AMBIENT** — someone the world is more alive for. No shop. Cast by role
affinity for the place (elders at the arrival point, mercenaries at the cave
mouth, scouts at bridges, wanderers on roads). Picked from characters2 **by
role**, so new NPC art joins the pool with no edit here.

**MERCHANT** — has something to sell, and **must look like it**.
`MERCHANT_LOOK` in `pipeline/npcs.py` is the one hand-curated table in the
whole placement system, on purpose: "looks like a merchant" is a judgement
about ART no terrain rule can make. Only characters whose sprite visibly
presents wares are eligible. The `trader` ROLE is deliberately **not**
sufficient: of characters2' two traders, Joss holds up four filled vials and is
in; Halvard is a fur-collared traveller with a waterskin and is out — a
character like that in a shop reads as a lost villager.

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

Landmarks are **derived from world.json**; no world knows it is being
decorated, and a new world gets a cast for free.

| anchor | derived as | who goes there |
|---|---|---|
| `arrival` | the player spawn | elders/scholars — you have just fallen, and somebody should be there |
| `house` | a `kind:"roof"` deck; the focus is its **doorway** | the market: general store, armourer, weaponsmith, plus residents |
| `cave` | cave-floor cells that meet open ground at a walkable step — the mouth — anchored **outside** | the alchemist (the last shop before you go down) and mercenaries |
| `bridge` | the biggest `kind:"bridge"` deck, anchored at its **end** | a merchant at a chokepoint everybody crosses, and a scout |
| `road` | junction cells (degree ≥ 3) of the dirt-road graph, spread ≥ 40 cells apart | the soulstone dealer — the stone trade IS the economy (`lore/RED_LINE.md` §6) — and travellers |
| `shore` | beach cells touching water | people looking out to sea |

## The laws

Asserted for every NPC of every world before the file is written, so a terrain
change breaks the **build** rather than stranding somebody in the deployed
game.

1. **Dry, standable ground.** Never water (the water law applies to people
   too), never void, never a prop cell, never sealed under a slab.
2. **Reachable on foot from the player spawn**, walked with the game's own rule
   (4-neighbour, climb ≤ `WALK_CLIMB` = 1, drops free, `baseUnderDeckOpen` for
   ground under a deck). *A shop you cannot walk to is not a shop.*
3. **Never in a chokepoint.** Detected by counting runs of open ground around
   the 8 neighbours: ≥2 runs means the space on either side only connects
   *through* you.
4. **Never in a doorway — stand NEXT to an opening, never in front of it**
   (maintainer: "Why can't they stand next to instead of in front the
   door/entrance?"). A **portal** is a door, a cave mouth or a bridge head, and
   "in the opening" has **two** meanings, both kept clear:
   - the **grid lane** — the cells straight out along the passage; and
   - the **screen strip** — cells within `DOOR_COLS` of the opening's `(x−y)`
     and in front of it. This is the one that bites: a door at `(201,117)` and
     an NPC at `(202,118)` share the *identical* screen column `84`, so he
     stands squarely in the opening while the grid lane is perfectly clear.

   Clearance is measured from the **opening itself** — the gap in the wall, the
   cave-floor cell at the mouth — not from the step outside it (that is off by
   one column and lets a sprite clip the edge of the door).
5. **Never in the spawn campfire.** The game draws one animated campfire at
   every world's arrival point — the only `scenery/` asset it draws, and canon
   (`lore/RED_LINE.md` §2). It is **not** a prop in `world.json`, so nothing in
   the terrain says it is there — the first cast stood a commoner in the
   flames. `WorldScene.ts placeCampfire()` takes the first standable same-level
   neighbour of the spawn from a fixed offset order; `fire_cells()`
   deliberately does **not** trust its own standability test to agree with
   theirs, and keeps every candidate up to *and including* the first it
   believes standable, plus a one-cell ring — so a small disagreement still
   lands on a clear cell.
6. **Never hidden from the camera.** Derived from the painter order `(x+y, y)`,
   not guessed — which catches equal `x+y` with greater `y`, i.e. one step
   round the side of a building. An NPC nobody can see is worse than no NPC.
7. **Never overlapping another sprite**, measured in **screen** space: iso puts
   `(x+2, y+2)` directly below `(x, y)` with 60px between them, so grid
   distance happily stacks two sprites into one blob. Side by side needs 3
   columns (96px) — 2 leaves them shoulder-to-shoulder.
8. **Not on or crowding the arrival point** — you land in open ground.
9. **References resolve**: the character exists in characters2, its art is on
   disk, `name` still matches upstream, every ware is a real `items/` TYPE.
10. **Indoors is off limits** — the house belongs to whoever lives there; the
    market forms outside the door. (The cave is explicitly *not* indoors.)

`prop_demo`, `trans_demo`, `glow_test`, `occlusion_test`, `house_demo` and
`monster_demo` ship an explicit empty `npcs: []` (`NO_NPC_WORLDS`) — they each
exercise one feature and people would only get in the way.

## Rebuilding

```
python maps2/pipeline/npcs.py                # every world
python maps2/pipeline/npcs.py the_island2    # only the named ones
python maps2/pipeline/npcs.py --check        # validate what is on disk, exit 1 on any violation
```

You rarely need to: `worldio.save_world()` re-derives the sidecars for the
world it just wrote, so `build.py <world>` and running a builder directly both
re-place the cast against the new terrain automatically.

## Consumers

**Live.** The client fetches `npcs.json` per world and draws the cast
(`WorldScene.addNpc`). NPC art ships via its own manifest,
`games2/scripts/build-npcs-manifest.mjs` (parallel to the player and monster
manifests; validated by `games2/scripts/verify-npcs.mjs`) — that manifest
answers "what does character `<id>` look like"; WHO stands WHERE is this file.
